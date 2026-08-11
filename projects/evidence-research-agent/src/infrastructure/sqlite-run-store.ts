import { mkdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  parseResearchRunEvent,
  parseRunProjection,
} from "../domain/schemas.js";
import { reduceRunEvents } from "../domain/reducer.js";
import type {
  PersistedArtifact,
  ResearchRunEvent,
  RunProjection,
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

export class RunNotFoundError extends Error {}

export class ConcurrentRunWriteError extends Error {}

/** SQLite-backed Run Journal 与可丢弃的 Projection cache。 */
export class SqliteRunStore {
  /** 当前 Runtime Home 独占的同步 SQLite 连接。 */
  readonly #database: Database.Database;

  public constructor(runtimeHome: string) {
    mkdirSync(runtimeHome, { recursive: true });
    this.#database = new Database(join(runtimeHome, "runtime.sqlite"));
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#migrate();
  }

  public appendEvents(
    runId: string,
    expectedLastSequence: number,
    events: readonly ResearchRunEvent[],
    artifacts: readonly PersistedArtifact[] = [],
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

      if (lastSequence === 0) {
        const firstEvent = events[0];
        if (firstEvent === undefined) {
          throw new Error("创建 Run 时至少需要一个事件");
        }
        this.#database
          .prepare("INSERT INTO runs (run_id, created_at) VALUES (?, ?)")
          .run(runId, firstEvent.occurredAt);
      }

      for (const artifact of artifacts) {
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO artifacts
              (artifact_id, sha256, media_type, byte_length, relative_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifact.artifactId,
            artifact.sha256,
            artifact.mediaType,
            artifact.byteLength,
            artifact.relativePath,
            artifact.createdAt,
          );
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
    const row = this.#database
      .prepare("SELECT projection_json FROM run_projections WHERE run_id = ?")
      .get(runId) as ProjectionRow | undefined;
    if (row === undefined) {
      return this.rebuildProjection(runId);
    }
    return parseRunProjection(JSON.parse(row.projection_json));
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
    `);
  }
}
