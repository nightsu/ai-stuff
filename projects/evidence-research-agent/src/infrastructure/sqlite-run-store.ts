import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import { ZodError } from "zod";

import {
  parseResearchRunEvent,
  parseRunProjection,
} from "../domain/schemas.js";
import { reduceRunEvents } from "../domain/reducer.js";
import { sourceSnapshotHasMatchingContentIdentity } from "../domain/integrity.js";
import type {
  ArtifactReference,
  PersistedArtifact,
  PersistedSourceSnapshot,
  ResearchRunEvent,
  RunCancellationRequest,
  RunOperationLease,
  RunOperationView,
  RunProjection,
  SourceSnapshotReference,
} from "../domain/types.js";

interface EventRow {
  /** 事件在 Run 内从 1 开始的连续序号。 */
  readonly sequence: number;
  /** 跨重试稳定的事件 identity。 */
  readonly event_id: string;
  /** 用于恢复状态机的 Run Journal 语义事件类型。 */
  readonly type: string;
  /** ISO 8601 UTC 事件时间。 */
  readonly occurred_at: string;
  /** 事件类型化载荷的 JSON 文本。 */
  readonly payload_json: string;
}

interface ProjectionRow {
  /** 缓存投影的 JSON 文本；读取时仍需做 schema 校验。 */
  readonly projection_json: string;
}

interface LastSequenceRow {
  /** Journal 当前最大序号；空 Journal 使用 0。 */
  readonly last_sequence: number;
}

interface ArtifactRow {
  /** 通用 private artifact 的内容寻址 identity。 */
  readonly artifact_id: string;
  /** artifact 精确内容的小写 SHA-256 摘要。 */
  readonly sha256: string;
  /** 该 artifact 的固定媒体类型。 */
  readonly media_type: string;
  /** artifact 精确持久化字节数。 */
  readonly byte_length: number;
  /** 相对于 Runtime Home 的私有 artifact 路径。 */
  readonly relative_path: string;
  /** artifact 在 registry 的首次登记时间。 */
  readonly created_at: string;
}

interface SourceSnapshotRow {
  /** Source Snapshot 的内容寻址 identity。 */
  readonly snapshot_id: string;
  /** 完整原始源字节的 SHA-256 摘要。 */
  readonly sha256: string;
  /** 固定的 UTF-8 文本媒体类型。 */
  readonly media_type: string;
  /** 完整原始源文件的精确字节数。 */
  readonly byte_length: number;
  /** 相对于 canonical Runtime Home 的私有 CAS 路径。 */
  readonly relative_path: string;
  /** 该内容 identity 首次登记的 ISO 8601 UTC 时间。 */
  readonly created_at: string;
}

interface RunOperationRow {
  /** lease 所保护的 Research Run identity。 */
  readonly run_id: string;
  /** 当前 command-owned operation identity。 */
  readonly operation_id: string;
  /** 持有 lease 的 Runtime 实例 identity。 */
  readonly owner_id: string;
  /** 不参与 Run Projection 的 command 类别。 */
  readonly kind: RunOperationLease["kind"];
  /** lease 首次获取的 ISO 8601 UTC 时间。 */
  readonly acquired_at: string;
  /** 最近 durable heartbeat 的 ISO 8601 UTC 时间。 */
  readonly heartbeat_at: string;
  /** 其他 owner 可接管此 lease 的 ISO 8601 UTC 截止时间。 */
  readonly expires_at: string;
}

interface RunCancellationRequestRow {
  /** 请求终止的 Research Run identity。 */
  readonly run_id: string;
  /** durable cancellation request identity。 */
  readonly request_id: string;
  /** 请求首次 durable 创建的 ISO 8601 UTC 时间。 */
  readonly requested_at: string;
  /** 请求转化为 canonical cancellation 的时间。 */
  readonly consumed_at: string | null;
  /** 消费请求的 operation identity。 */
  readonly consumed_by_operation_id: string | null;
}

interface RunIdentityRow {
  /** SQLite 中已存在的 Research Run identity。 */
  readonly run_id: string;
}

/** appendEvents 可选的 control-plane 原子变更。 */
export interface AppendEventsControl {
  /** 当前 command chain 持有的 operation identity；存在 lease 时必须提供。 */
  readonly operationId?: string | undefined;
  /** 创建新 Run 时与初始 Journal 同事务取得的 operation lease。 */
  readonly initialOperationLease?: RunOperationLease | undefined;
  /** 与 `run_cancelled` 同事务结算的 durable cancellation request。 */
  readonly consumedCancellation?: {
    /** 必须仍未消费的 cancellation request identity。 */
    readonly requestId: string;
    /** canonical cancellation 成为事实的 ISO 8601 UTC 时间。 */
    readonly consumedAt: string;
    /** 代表活跃 command 消费时的 operation identity；独立 cancel 可省略。 */
    readonly operationId?: string | undefined;
  } | undefined;
}

export class RunNotFoundError extends Error {}

export class ConcurrentRunWriteError extends Error {}

/** 另一个未到期 owner 已持有同一 Run 的 mutating operation lease。 */
export class RunOperationBusyError extends Error {}

/** 当前 owner 无法再续租其 operation 时抛出的内部控制面错误。 */
export class RunOperationLeaseLostError extends Error {}

/** Journal mutation 发现更早 durable 的未消费 cancellation request。 */
export class RunCancellationPendingError extends Error {}

/** cancellation request 竞争时发现 Run 已先进入 terminal state。 */
export class RunCancellationTerminalError extends Error {}

/** cancellation request 竞争时发现 Publication Effect outcome 尚未结算。 */
export class RunCancellationUnsettledPublicationError extends Error {}

export class SourceSnapshotRegistrationError extends Error {
  public constructor() {
    super("Source Snapshot registry 完整性校验失败");
    this.name = "SourceSnapshotRegistrationError";
  }
}

/** 通用 artifact registry 无法与 Journal 引用原子对应时抛出的内部错误。 */
export class ArtifactEventInvariantError extends Error {
  public constructor() {
    super("Artifact registry 与 Journal 事件的事务不变量校验失败");
    this.name = "ArtifactEventInvariantError";
  }
}

/** Journal observation 与独立 Source Snapshot registry 无法原子对应。 */
export class SourceSnapshotEventInvariantError extends Error {
  public constructor() {
    super("Source Snapshot 与来源读取事件的事务不变量校验失败");
    this.name = "SourceSnapshotEventInvariantError";
  }
}

/** SQLite-backed Run Journal 与可丢弃的 Projection cache。 */
export class SqliteRunStore {
  /** 当前 Runtime Home 独占的同步 SQLite 连接。 */
  readonly #database: Database.Database;
  /** 返回 control-plane 当前时间，用于在 Journal 事务内校验 lease 尚未过期。 */
  readonly #controlPlaneNow: () => string;

  public constructor(
    runtimeHome: string,
    controlPlaneNow: () => string = () => new Date().toISOString(),
  ) {
    this.#database = new Database(join(runtimeHome, "runtime.sqlite"));
    this.#controlPlaneNow = controlPlaneNow;
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#migrate();
  }

  public appendEvents(
    runId: string,
    expectedLastSequence: number,
    events: readonly ResearchRunEvent[],
    artifacts: readonly PersistedArtifact[] = [],
    sourceSnapshots: readonly PersistedSourceSnapshot[] = [],
    control: AppendEventsControl = {},
  ): RunProjection {
    if (events.length === 0) {
      throw new Error("appendEvents 至少需要一个语义事件");
    }
    events.forEach((event, index) => {
      if (event.runId !== runId) {
        throw new Error("追加批次不能混入其他 Research Run 的事件");
      }
      if (event.sequence !== expectedLastSequence + index + 1) {
        throw new Error("追加批次的事件序号必须紧接 expectedLastSequence");
      }
    });

    const transaction = this.#database.transaction(() => {
      const lastSequence = this.#readLastSequence(runId);
      if (lastSequence !== expectedLastSequence) {
        throw new ConcurrentRunWriteError(
          `Run ${runId} 期望序号 ${expectedLastSequence}，实际为 ${lastSequence}`,
        );
      }

      const pendingCancellation = lastSequence === 0
        ? undefined
        : this.#readCancellationRequestRow(runId);
      if (
        pendingCancellation?.consumed_at === null &&
        control.consumedCancellation === undefined
      ) {
        // cancellation request 是独立 durable control fact。它一旦先提交，后续
        // mutation 不能在 heartbeat 间隙越过它；caller 必须先原子写 run_cancelled
        // 并消费 request，再决定完整 late result 是否进入 cancelled snapshot。
        throw new RunCancellationPendingError();
      }
      const activeOperation = this.#readRunOperationRow(runId);
      if (activeOperation !== undefined) {
        if (
          activeOperation.operation_id !== control.operationId ||
          Date.parse(activeOperation.expires_at) <=
            Date.parse(this.#controlPlaneNow())
        ) {
          // operation identity 随异步 command chain 进入每次 mutation；因此同一
          // Runtime 内的新 command 也不能覆盖旧 owner 的 fencing token。expiry
          // 后无论是否已有接管者，旧 I/O 都不得把迟到结果写入 canonical Journal。
          throw new RunOperationLeaseLostError();
        }
      } else if (control.operationId !== undefined) {
        throw new RunOperationLeaseLostError();
      }

      if (lastSequence === 0) {
        const firstEvent = events[0];
        if (firstEvent === undefined) {
          throw new Error("创建 Run 时至少需要一个事件");
        }
        this.#database
          .prepare("INSERT INTO runs (run_id, created_at) VALUES (?, ?)")
          .run(runId, firstEvent.occurredAt);
        if (control.initialOperationLease !== undefined) {
          if (control.initialOperationLease.runId !== runId) {
            throw new RunOperationLeaseLostError();
          }
          this.#insertRunOperation(control.initialOperationLease);
        }
      } else if (control.initialOperationLease !== undefined) {
        throw new RunOperationLeaseLostError();
      }

      const referencedArtifacts = collectArtifactReferences(events);
      for (const providedArtifact of artifacts) {
        if (
          !referencedArtifacts.some((reference) =>
            artifactReferenceMatches(reference, providedArtifact),
          )
        ) {
          // artifact registry 不是任意 payload 写入口：只有本批 Journal 真正引用的
          // plan/draft 才能登记，避免调用方把未审批内容塞进私有 registry 伪装可用。
          throw new ArtifactEventInvariantError();
        }
      }
      for (const artifact of artifacts) {
        this.#registerArtifact(artifact);
      }
      for (const reference of referencedArtifacts) {
        const row = this.#readArtifactRow(reference.artifactId);
        if (row === undefined || !artifactRowMatchesReference(row, reference)) {
          throw new ArtifactEventInvariantError();
        }
      }

      const referencedSourceSnapshots =
        collectSucceededSourceSnapshotReferences(events);
      for (const providedSnapshot of sourceSnapshots) {
        if (
          !referencedSourceSnapshots.some((reference) =>
            sourceSnapshotReferenceMatches(reference, providedSnapshot),
          )
        ) {
          // sourceSnapshots 不是任意 registry 写入口；调用方只能随同本批成功事件
          // 登记它实际引用的内容，否则 denial/failure 也会暗中获得发布能力。
          throw new SourceSnapshotEventInvariantError();
        }
      }

      for (const sourceSnapshot of sourceSnapshots) {
        this.#registerSourceSnapshot(sourceSnapshot);
      }

      for (const reference of referencedSourceSnapshots) {
        const row = this.#readSourceSnapshotRow(reference.snapshotId);
        if (
          row === undefined ||
          !sourceSnapshotRowMatchesReference(row, reference)
        ) {
          // Journal 是成功事实源：只有 registry 中已经存在全字段一致的冻结内容，
          // 成功 observation 才能在同一事务继续写入。任何失败都会回滚本事务内
          // 的新登记与事件，事务外提前发布的私有 CAS orphan 可由后续 GC 回收。
          throw new SourceSnapshotEventInvariantError();
        }
      }

      const insertEvent = this.#database.prepare(
        `INSERT INTO run_events
          (run_id, sequence, event_id, type, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const event of events) {
        insertEvent.run(
          event.runId,
          event.sequence,
          event.eventId,
          event.type,
          event.occurredAt,
          JSON.stringify(event.payload),
        );
      }

      if (control.consumedCancellation !== undefined) {
        if (!events.some((event) => event.type === "run_cancelled")) {
          throw new RunOperationLeaseLostError();
        }
        const result = this.#database.prepare(
          `UPDATE run_cancellation_requests
              SET consumed_at = ?, consumed_by_operation_id = ?
            WHERE run_id = ? AND request_id = ? AND consumed_at IS NULL`,
        ).run(
          control.consumedCancellation.consumedAt,
          control.consumedCancellation.operationId ?? null,
          runId,
          control.consumedCancellation.requestId,
        );
        if (result.changes !== 1) throw new RunOperationLeaseLostError();
      }

      // Journal 与缓存投影在同一短事务提交。崩溃只会得到“都可见”或“都不可见”，
      // 而 Projection 即使被删除，也可由下方同一个 reducer 重新生成。
      const projection = reduceRunEvents(this.readEvents(runId));
      this.#database
        .prepare(
          `INSERT INTO run_projections
            (run_id, last_event_sequence, projection_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             last_event_sequence = excluded.last_event_sequence,
             projection_json = excluded.projection_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          runId,
          projection.lastEventSequence,
          JSON.stringify(projection),
          projection.updatedAt,
        );
      return projection;
    });

    // 在读取 last sequence 前取得 RESERVED 写锁，避免两个进程都基于同一旧序号推进。
    return transaction.immediate();
  }

  public readProjection(runId: string): RunProjection {
    const transaction = this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT projection_json FROM run_projections WHERE run_id = ?")
        .get(runId) as ProjectionRow | undefined;
      const replayed = reduceRunEvents(this.readEvents(runId));
      if (row === undefined) {
        return replayed;
      }

      let cached: RunProjection;
      try {
        cached = parseRunProjection(JSON.parse(row.projection_json));
      } catch (error) {
        // cache 是可丢弃的派生数据，所以只对 JSON/Zod 解析损坏降级；Journal
        // 已在 try 外成功回放，其他事务或领域错误绝不能被这里吞掉。
        if (error instanceof SyntaxError || error instanceof ZodError) {
          return replayed;
        }
        throw error;
      }
      // Projection cache 没有独立授权力：schema-valid 仍可能是被一致篡改的值。
      // 同一 SQLite 读事务内回放 canonical Journal，只有完全相等才接受 cache。
      return isDeepStrictEqual(cached, replayed) ? cached : replayed;
    });
    return transaction();
  }

  public readEvents(runId: string): ResearchRunEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, event_id, type, occurred_at, payload_json
           FROM run_events
          WHERE run_id = ?
          ORDER BY sequence ASC`,
      )
      .all(runId) as EventRow[];
    if (rows.length === 0) {
      throw new RunNotFoundError(`找不到 Research Run：${runId}`);
    }

    return rows.map((row) =>
      parseResearchRunEvent({
        eventId: row.event_id,
        runId,
        sequence: row.sequence,
        type: row.type,
        occurredAt: row.occurred_at,
        payload: JSON.parse(row.payload_json),
      }),
    );
  }

  public rebuildProjection(runId: string): RunProjection {
    const transaction = this.#database.transaction(() => {
      const projection = reduceRunEvents(this.readEvents(runId));
      this.#database
        .prepare(
          `INSERT INTO run_projections
            (run_id, last_event_sequence, projection_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             last_event_sequence = excluded.last_event_sequence,
             projection_json = excluded.projection_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          runId,
          projection.lastEventSequence,
          JSON.stringify(projection),
          projection.updatedAt,
        );
      return projection;
    });

    // 重建必须先锁定写入顺序再读 Journal；否则并发追加可在读写间隙提交，
    // 让旧 Projection 覆盖已经更新的 cache。
    return transaction.immediate();
  }

  public prepareSourceSnapshotRegistration(
    snapshot: PersistedSourceSnapshot,
  ): PersistedSourceSnapshot {
    this.#validateSourceSnapshot(snapshot);
    const row = this.#readSourceSnapshotRow(snapshot.snapshotId);
    if (row === undefined) {
      return snapshot;
    }
    if (!sourceSnapshotRowMatches(row, snapshot, false)) {
      throw new SourceSnapshotRegistrationError();
    }
    // created_at 是 registry 的首次创建事实；相同内容稍后再次 capture 时沿用该
    // 值，observation 自己的 observedAt 仍保留本次读取时间，两种时间语义不混淆。
    return {
      snapshotId: row.snapshot_id,
      sha256: row.sha256,
      mediaType: "text/plain; charset=utf-8",
      byteLength: row.byte_length,
      relativePath: row.relative_path,
      createdAt: row.created_at,
    };
  }

  public acquireRunOperation(lease: RunOperationLease): RunOperationLease {
    const transaction = this.#database.transaction(() => {
      this.#assertRunExists(lease.runId);
      const existing = this.#readRunOperationRow(lease.runId);
      if (
        existing !== undefined &&
        Date.parse(existing.expires_at) > Date.parse(lease.acquiredAt)
      ) {
        throw new RunOperationBusyError();
      }
      // lease 只保护 command ownership；过期 owner 可在一个短事务内被替换，
      // 但接管者随后仍必须从 canonical Journal 恢复，绝不从旧 lease 猜业务结果。
      this.#insertRunOperation(lease);
      return lease;
    });
    return transaction.immediate();
  }

  public heartbeatRunOperation(
    runId: string,
    operationId: string,
    heartbeatAt: string,
    expiresAt: string,
  ): RunOperationLease {
    const result = this.#database.prepare(
      `UPDATE run_operations
          SET heartbeat_at = ?, expires_at = ?
        WHERE run_id = ? AND operation_id = ? AND expires_at > ?`,
    ).run(heartbeatAt, expiresAt, runId, operationId, heartbeatAt);
    if (result.changes !== 1) throw new RunOperationLeaseLostError();
    const row = this.#readRunOperationRow(runId);
    if (row === undefined) throw new RunOperationLeaseLostError();
    return runOperationFromRow(row);
  }

  public releaseRunOperation(runId: string, operationId: string): void {
    this.#database.prepare(
      "DELETE FROM run_operations WHERE run_id = ? AND operation_id = ?",
    ).run(runId, operationId);
  }

  public inspectRunOperation(runId: string): RunOperationView {
    this.#assertRunExists(runId);
    const lease = this.#readRunOperationRow(runId);
    const cancellationRequest = this.#database.prepare(
      `SELECT run_id, request_id, requested_at, consumed_at,
              consumed_by_operation_id
         FROM run_cancellation_requests
        WHERE run_id = ?`,
    ).get(runId) as RunCancellationRequestRow | undefined;
    return {
      lease: lease === undefined ? undefined : runOperationFromRow(lease),
      cancellationRequest: cancellationRequest === undefined
        ? undefined
        : cancellationRequestFromRow(cancellationRequest),
    };
  }

  public requestRunCancellation(
    request: RunCancellationRequest,
  ): RunCancellationRequest | undefined {
    const transaction = this.#database.transaction(() => {
      this.#assertRunExists(request.runId);
      const projection = reduceRunEvents(this.readEvents(request.runId));
      if (projection.state.type === "cancelled") return undefined;
      if (
        projection.state.type === "completed" ||
        projection.state.type === "failed"
      ) {
        throw new RunCancellationTerminalError();
      }
      if (
        projection.state.type === "publication_executing" ||
        projection.state.type === "publication_unknown" ||
        projection.state.type === "publication_conflict"
      ) {
        // request insert 与 Journal append 都用 IMMEDIATE 短事务排序：若 terminal
        // event 先提交，取消不能留下永远无法消费的 control-plane 残留；若 request
        // 先提交，appendEvents 的 pending-request fence 会让取消先结算。
        throw new RunCancellationUnsettledPublicationError();
      }
      const existing = this.#readCancellationRequestRow(request.runId);
      if (existing !== undefined) return cancellationRequestFromRow(existing);
      this.#database.prepare(
        `INSERT INTO run_cancellation_requests
          (run_id, request_id, requested_at, consumed_at,
           consumed_by_operation_id)
         VALUES (?, ?, ?, NULL, NULL)`,
      ).run(request.runId, request.requestId, request.requestedAt);
      return request;
    });
    return transaction.immediate();
  }

  public readPendingRunCancellation(
    runId: string,
  ): RunCancellationRequest | undefined {
    const row = this.#readCancellationRequestRow(runId);
    if (row === undefined || row.consumed_at !== null) return undefined;
    return cancellationRequestFromRow(row);
  }

  public close(): void {
    this.#database.close();
  }

  #readLastSequence(runId: string): number {
    const row = this.#database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM run_events WHERE run_id = ?",
      )
      .get(runId) as LastSequenceRow;
    return row.last_sequence;
  }

  #assertRunExists(runId: string): void {
    const row = this.#database.prepare(
      "SELECT run_id FROM runs WHERE run_id = ?",
    ).get(runId) as RunIdentityRow | undefined;
    if (row === undefined) throw new RunNotFoundError(`找不到 Research Run：${runId}`);
  }

  #readRunOperationRow(runId: string): RunOperationRow | undefined {
    return this.#database.prepare(
      `SELECT run_id, operation_id, owner_id, kind, acquired_at,
              heartbeat_at, expires_at
         FROM run_operations
        WHERE run_id = ?`,
    ).get(runId) as RunOperationRow | undefined;
  }

  #insertRunOperation(lease: RunOperationLease): void {
    this.#database.prepare(
      `INSERT INTO run_operations
        (run_id, operation_id, owner_id, kind, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         operation_id = excluded.operation_id,
         owner_id = excluded.owner_id,
         kind = excluded.kind,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at`,
    ).run(
      lease.runId,
      lease.operationId,
      lease.ownerId,
      lease.kind,
      lease.acquiredAt,
      lease.heartbeatAt,
      lease.expiresAt,
    );
  }

  #readCancellationRequestRow(
    runId: string,
  ): RunCancellationRequestRow | undefined {
    return this.#database.prepare(
      `SELECT run_id, request_id, requested_at, consumed_at,
              consumed_by_operation_id
         FROM run_cancellation_requests
        WHERE run_id = ?`,
    ).get(runId) as RunCancellationRequestRow | undefined;
  }

  #registerSourceSnapshot(snapshot: PersistedSourceSnapshot): void {
    this.#validateSourceSnapshot(snapshot);

    this.#database
      .prepare(
        `INSERT INTO source_snapshots
          (snapshot_id, sha256, media_type, byte_length, relative_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        snapshot.snapshotId,
        snapshot.sha256,
        snapshot.mediaType,
        snapshot.byteLength,
        snapshot.relativePath,
        snapshot.createdAt,
      );

    const row = this.#readSourceSnapshotRow(snapshot.snapshotId);
    // ON CONFLICT 只能承担显式验证后的并发幂等，绝不能像 INSERT OR IGNORE 一样
    // 把 identity/sha/path/media/bytes 冲突吞掉。跨 Run race 中 created_at 保留赢家
    // 首次登记时间；输家的本次读取时间已经由它自己的 observation 记录。
    if (
      row === undefined ||
      !sourceSnapshotRowMatches(row, snapshot, false)
    ) {
      throw new SourceSnapshotRegistrationError();
    }
  }

  #registerArtifact(artifact: PersistedArtifact): void {
    if (
      artifact.artifactId !== `sha256:${artifact.sha256}` ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      artifact.mediaType.trim() === "" ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 0 ||
      artifact.relativePath.trim() === "" ||
      !isIsoUtc(artifact.createdAt)
    ) {
      throw new ArtifactEventInvariantError();
    }
    this.#database
      .prepare(
        `INSERT INTO artifacts
          (artifact_id, sha256, media_type, byte_length, relative_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        artifact.artifactId,
        artifact.sha256,
        artifact.mediaType,
        artifact.byteLength,
        artifact.relativePath,
        artifact.createdAt,
      );
    const row = this.#readArtifactRow(artifact.artifactId);
    if (row === undefined || !artifactRowMatchesPersisted(row, artifact)) {
      throw new ArtifactEventInvariantError();
    }
  }

  #validateSourceSnapshot(snapshot: PersistedSourceSnapshot): void {
    if (
      !sourceSnapshotHasMatchingContentIdentity(snapshot) ||
      snapshot.mediaType !== "text/plain; charset=utf-8" ||
      !Number.isSafeInteger(snapshot.byteLength) ||
      snapshot.byteLength < 0 ||
      !isIsoUtc(snapshot.createdAt)
    ) {
      throw new SourceSnapshotRegistrationError();
    }
  }

  #readSourceSnapshotRow(snapshotId: string): SourceSnapshotRow | undefined {
    return this.#database
      .prepare(
        `SELECT snapshot_id, sha256, media_type, byte_length, relative_path, created_at
           FROM source_snapshots
          WHERE snapshot_id = ?`,
      )
      .get(snapshotId) as SourceSnapshotRow | undefined;
  }

  #readArtifactRow(artifactId: string): ArtifactRow | undefined {
    return this.#database
      .prepare(
        `SELECT artifact_id, sha256, media_type, byte_length, relative_path, created_at
           FROM artifacts
          WHERE artifact_id = ?`,
      )
      .get(artifactId) as ArtifactRow | undefined;
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS run_projections (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence > 0),
        projection_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_operations (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        operation_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_cancellation_requests (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        request_id TEXT NOT NULL UNIQUE,
        requested_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_operation_id TEXT
      );

      CREATE TRIGGER IF NOT EXISTS run_events_are_append_only_on_update
      BEFORE UPDATE ON run_events
      BEGIN
        SELECT RAISE(ABORT, 'run_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS run_events_are_append_only_on_delete
      BEFORE DELETE ON run_events
      BEGIN
        SELECT RAISE(ABORT, 'run_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS source_snapshots_are_immutable_on_update
      BEFORE UPDATE ON source_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'source_snapshots is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS source_snapshots_are_immutable_on_delete
      BEFORE DELETE ON source_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'source_snapshots is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS artifacts_are_immutable_on_update
      BEFORE UPDATE ON artifacts
      BEGIN
        SELECT RAISE(ABORT, 'artifacts is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS artifacts_are_immutable_on_delete
      BEFORE DELETE ON artifacts
      BEGIN
        SELECT RAISE(ABORT, 'artifacts is immutable');
      END;
    `);
  }
}

function runOperationFromRow(row: RunOperationRow): RunOperationLease {
  return {
    runId: row.run_id,
    operationId: row.operation_id,
    ownerId: row.owner_id,
    kind: row.kind,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function cancellationRequestFromRow(
  row: RunCancellationRequestRow,
): RunCancellationRequest {
  return {
    runId: row.run_id,
    requestId: row.request_id,
    requestedAt: row.requested_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.consumed_by_operation_id === null
      ? {}
      : { consumedByOperationId: row.consumed_by_operation_id }),
  };
}

function isIsoUtc(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function sourceSnapshotRowMatches(
  row: SourceSnapshotRow,
  snapshot: PersistedSourceSnapshot,
  requireCreatedAtMatch: boolean,
): boolean {
  return (
    row.snapshot_id === snapshot.snapshotId &&
    row.sha256 === snapshot.sha256 &&
    row.media_type === snapshot.mediaType &&
    row.byte_length === snapshot.byteLength &&
    row.relative_path === snapshot.relativePath &&
    isIsoUtc(row.created_at) &&
    (!requireCreatedAtMatch || row.created_at === snapshot.createdAt)
  );
}

function collectArtifactReferences(
  events: readonly ResearchRunEvent[],
): ArtifactReference[] {
  const references: ArtifactReference[] = [];
  for (const event of events) {
    if (event.type === "plan_proposed") {
      references.push(event.payload.planArtifact);
    }
    if (event.type === "learning_artifact_draft_proposed") {
      references.push(event.payload.draftArtifact);
      if (event.payload.evaluation.kind === "reviewed") {
        references.push(event.payload.evaluation.reviewArtifact);
      }
    }
    if (
      event.type === "research_tool_observed" &&
      event.payload.observation.output !== undefined &&
      "searchResultArtifact" in event.payload.observation.output
    ) {
      references.push(event.payload.observation.output.searchResultArtifact);
    }
  }
  return references;
}

function artifactReferenceMatches(
  reference: ArtifactReference,
  artifact: PersistedArtifact,
): boolean {
  return (
    reference.artifactId === artifact.artifactId &&
    reference.sha256 === artifact.sha256 &&
    reference.mediaType === artifact.mediaType &&
    reference.byteLength === artifact.byteLength &&
    reference.relativePath === artifact.relativePath
  );
}

function artifactRowMatchesPersisted(
  row: ArtifactRow,
  artifact: PersistedArtifact,
): boolean {
  return artifactRowMatchesReference(row, artifact) && isIsoUtc(row.created_at);
}

function artifactRowMatchesReference(
  row: ArtifactRow,
  reference: ArtifactReference,
): boolean {
  return (
    row.artifact_id === reference.artifactId &&
    row.sha256 === reference.sha256 &&
    row.media_type === reference.mediaType &&
    row.byte_length === reference.byteLength &&
    row.relative_path === reference.relativePath
  );
}

function collectSucceededSourceSnapshotReferences(
  events: readonly ResearchRunEvent[],
): SourceSnapshotReference[] {
  const references: SourceSnapshotReference[] = [];
  for (const event of events) {
    if (event.type !== "source_read_observed") {
      continue;
    }
    const observation = event.payload.observation;
    if (observation.status === "succeeded") {
      references.push(observation.sourceSnapshot);
      continue;
    }
    if ("sourceSnapshot" in observation) {
      throw new SourceSnapshotEventInvariantError();
    }
  }
  return references;
}

function sourceSnapshotReferenceMatches(
  reference: SourceSnapshotReference,
  snapshot: PersistedSourceSnapshot,
): boolean {
  return (
    reference.snapshotId === snapshot.snapshotId &&
    reference.sha256 === snapshot.sha256 &&
    reference.mediaType === snapshot.mediaType &&
    reference.byteLength === snapshot.byteLength &&
    reference.relativePath === snapshot.relativePath
  );
}

function sourceSnapshotRowMatchesReference(
  row: SourceSnapshotRow,
  reference: SourceSnapshotReference,
): boolean {
  return (
    row.snapshot_id === reference.snapshotId &&
    row.sha256 === reference.sha256 &&
    row.media_type === reference.mediaType &&
    row.byte_length === reference.byteLength &&
    row.relative_path === reference.relativePath
  );
}
