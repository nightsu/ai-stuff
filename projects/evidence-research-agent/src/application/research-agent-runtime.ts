import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  createPlanApprovalBinding,
  hashReadSourceRequest,
  hashUtf8Text,
} from "../domain/integrity.js";
import { buildRunTrace } from "../domain/reducer.js";
import {
  parseResearchPlan,
  readSourceRequestSchema,
  parseRequestedSourceScope,
  parseRunBudget,
} from "../domain/schemas.js";
import type {
  Claim,
  EvidenceRecord,
  ResearchRunEvent,
  PersistedSourceSnapshot,
  ReadSourceRequest,
  RunProjection,
  RunTrace,
  SourceReadObservation,
  SourceScope,
} from "../domain/types.js";
import { ContentAddressedArtifactStore } from "../infrastructure/content-addressed-artifact-store.js";
import {
  canonicalizeSourceScope,
  PrivateSourceAccess,
  SourceScopeCanonicalizationError,
} from "../infrastructure/private-source-access.js";
import {
  ConcurrentRunWriteError,
  RunNotFoundError,
  SourceSnapshotRegistrationError,
  SqliteRunStore,
} from "../infrastructure/sqlite-run-store.js";
import { preparePrivateRuntimeHome } from "../infrastructure/private-runtime-home.js";
import type { Clock, IdGenerator, ModelPort } from "./ports.js";

/** 打开一个 headless runtime 所需的基础设施与可控边界。 */
export interface OpenRuntimeOptions {
  /** 私有且应被 git ignore 的 Runtime Home 路径。 */
  readonly runtimeHome: string;
  /** 计划生成使用的 Model Port；inspect 与 trace 不会调用它。 */
  readonly model: ModelPort;
  /** 可选时间边界；生产默认使用系统 UTC 时间。 */
  readonly clock?: Clock;
  /** 可选 identity 边界；生产默认使用 UUID。 */
  readonly ids?: IdGenerator;
}

/** 创建新 Research Run 的应用命令。 */
export interface CreateRunCommand {
  /** 要研究的非空本地技术问题；持久化前会移除首尾空白。 */
  readonly question: string;
  /** 本次 Run 冻结记录的 Source Scope。 */
  readonly sourceScope: unknown;
  /** 本次 Run 冻结记录且不可由模型修改的版本化 Run Budget。 */
  readonly runBudget: unknown;
}

/** 通过 identity 读取当前 Run Projection 的应用命令。 */
export interface InspectRunCommand {
  /** 要读取的 Research Run identity。 */
  readonly runId: string;
}

/** 通过 identity 读取派生 Run Trace 的应用命令。 */
export interface TraceRunCommand {
  /** 要投影为 Trace 的 Research Run identity。 */
  readonly runId: string;
}

/** 从 canonical Journal 显式重建 Projection cache 的应用命令。 */
export interface RebuildRunProjectionCommand {
  /** 要重建缓存投影的 Research Run identity。 */
  readonly runId: string;
}

/** 用用户可见 binding hash 批准一个精确计划版本的应用命令。 */
export interface ApprovePlanCommand {
  /** 当前处于计划审批等待状态的 Research Run identity。 */
  readonly runId: string;
  /** 用户从等待投影提交回来的完整聚合审批摘要。 */
  readonly bindingHash: string;
}

/** 对一个已批准 Research Run 执行显式来源读取的应用命令。 */
export interface ReadSourceCommand {
  /** 当前必须处于 researching 的 Research Run identity。 */
  readonly runId: string;
  /** 唯一允许由调用方提供的结构化 Research Tool 参数。 */
  readonly request: ReadSourceRequest;
}

/** 从一个已持久化成功 observation 登记结构化 Evidence Record 的应用命令。 */
export interface RecordEvidenceCommand {
  /** 当前必须仍处于 researching 的 Research Run identity。 */
  readonly runId: string;
  /** 唯一允许调用方选择的成功 Source Read Observation identity。 */
  readonly observationId: string;
}

/** 提交一个只能引用既有 Evidence Record 的最小 Claim 的应用命令。 */
export interface RecordClaimCommand {
  /** 当前必须仍处于 researching 的 Research Run identity。 */
  readonly runId: string;
  /** 不包含预渲染 citation 的简短、非空 Claim 文本。 */
  readonly text: string;
  /** 至少一个既有 Evidence identity，顺序是未来渲染的显式引用顺序。 */
  readonly evidenceIds: readonly string[];
}

/** 提交的 binding 已不再对应当前等待计划时抛出的安全错误。 */
export class StalePlanApprovalError extends Error {
  public constructor() {
    super("计划审批已过期或与当前等待版本不匹配");
    this.name = "StalePlanApprovalError";
  }
}

/** 非等待状态收到新的计划审批命令时抛出的领域错误。 */
export class IllegalPlanApprovalStateError extends Error {
  public constructor(state: RunProjection["state"]["type"]) {
    super(`当前 ${state} 状态不能接受新的计划审批`);
    this.name = "IllegalPlanApprovalStateError";
  }
}

/** 计划审批命令不满足公开输入契约时抛出的安全应用错误。 */
export class InvalidPlanApprovalCommandError extends Error {
  public constructor() {
    super("计划审批命令格式无效");
    this.name = "InvalidPlanApprovalCommandError";
  }
}

/** 乐观冲突后无法确认同一审批结果时抛出的安全应用错误。 */
export class PlanApprovalConflictError extends Error {
  public constructor() {
    super("计划审批与另一项 Run 更新发生冲突");
    this.name = "PlanApprovalConflictError";
  }
}

/** Source Scope 请求无法安全绑定时抛出的 payload-safe 应用错误。 */
export class InvalidSourceScopeError extends Error {
  public constructor() {
    super("Source Scope 无效或本地根不可用");
    this.name = "InvalidSourceScopeError";
  }
}

/** 来源读取命令不满足严格公开输入契约时抛出的安全错误。 */
export class InvalidSourceReadCommandError extends Error {
  public constructor() {
    super("来源读取命令格式无效");
    this.name = "InvalidSourceReadCommandError";
  }
}

/** 未知 Run 收到来源读取命令时抛出的 payload-safe 应用错误。 */
export class SourceReadRunNotFoundError extends Error {
  public constructor() {
    super("找不到可读取来源的 Research Run");
    this.name = "SourceReadRunNotFoundError";
  }
}

/** 非 researching Run 收到来源读取命令时抛出的安全状态错误。 */
export class IllegalSourceReadStateError extends Error {
  public constructor() {
    super("当前 Research Run 状态不能读取来源");
    this.name = "IllegalSourceReadStateError";
  }
}

/** 来源捕获后 Journal 已被其他命令推进时抛出的安全冲突错误。 */
export class SourceReadConflictError extends Error {
  public constructor() {
    super("来源读取与另一项 Run 更新发生冲突");
    this.name = "SourceReadConflictError";
  }
}

/** 私有 snapshot 或 registry 无法安全提交时抛出的消毒后错误。 */
export class SourceReadPersistenceError extends Error {
  public constructor() {
    super("来源读取结果无法安全持久化");
    this.name = "SourceReadPersistenceError";
  }
}

/** Evidence 命令不满足严格公开输入契约时抛出的安全错误。 */
export class InvalidEvidenceCommandError extends Error {
  public constructor() {
    super("Evidence 命令格式无效");
    this.name = "InvalidEvidenceCommandError";
  }
}

/** 当前 Run 中不存在可登记的成功来源 observation 时抛出的安全错误。 */
export class EvidenceObservationNotAvailableError extends Error {
  public constructor() {
    super("指定的来源 observation 不能登记为 Evidence");
    this.name = "EvidenceObservationNotAvailableError";
  }
}

/** 非 researching Run 收到 Evidence 或 Claim 命令时抛出的安全状态错误。 */
export class IllegalEvidenceStateError extends Error {
  public constructor() {
    super("当前 Research Run 状态不能登记 Evidence 或 Claim");
    this.name = "IllegalEvidenceStateError";
  }
}

/** Claim 命令不满足严格公开输入契约时抛出的安全错误。 */
export class InvalidClaimCommandError extends Error {
  public constructor() {
    super("Claim 命令格式无效");
    this.name = "InvalidClaimCommandError";
  }
}

/** Claim 试图引用当前 Run 中不存在的 Evidence 时抛出的安全错误。 */
export class ClaimEvidenceNotAvailableError extends Error {
  public constructor() {
    super("Claim 必须引用当前 Run 中已有的 Evidence");
    this.name = "ClaimEvidenceNotAvailableError";
  }
}

/** Evidence/Claim 追加与另一项 Run 更新冲突时抛出的安全错误。 */
export class EvidenceWriteConflictError extends Error {
  public constructor() {
    super("Evidence 或 Claim 与另一项 Run 更新发生冲突");
    this.name = "EvidenceWriteConflictError";
  }
}

/** Evidence/Claim 写入的内部领域或持久化错误被消毒后的公开错误。 */
export class EvidencePersistenceError extends Error {
  public constructor() {
    super("Evidence 或 Claim 无法安全持久化");
    this.name = "EvidencePersistenceError";
  }
}

const createRunCommandSchema = z.object({
  question: z.string().trim().min(1),
  sourceScope: z.unknown(),
  runBudget: z.unknown(),
});

const runIdentityCommandSchema = z.object({
  runId: z.string().trim().min(1),
});

const approvePlanCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const readSourceCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    request: readSourceRequestSchema,
  })
  .strict();

const recordEvidenceCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    observationId: z.string().trim().min(1),
  })
  .strict();

const recordClaimCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    text: z.string().trim().min(1),
    evidenceIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

const uuidGenerator: IdGenerator = {
  nextRunId: () => `run-${randomUUID()}`,
  nextEventId: () => `event-${randomUUID()}`,
  nextApprovalId: () => `approval-${randomUUID()}`,
  nextToolCallId: () => `tool-call-${randomUUID()}`,
  nextObservationId: () => `observation-${randomUUID()}`,
};

/** CLI 与未来 UI 共同依赖的 command-oriented application seam。 */
export class ResearchAgentRuntime {
  /** 为事件与 artifact 提供可测试时间的边界。 */
  readonly #clock: Clock;
  /** 为 Run 与事件提供可测试 identity 的边界。 */
  readonly #ids: IdGenerator;
  /** 生成研究计划且不泄漏 provider SDK 类型的模型边界。 */
  readonly #model: ModelPort;
  /** 持久化大 payload、只向 Journal 返回内容引用的 artifact 组件。 */
  readonly #artifacts: ContentAddressedArtifactStore;
  /** 持有 canonical Journal 与 derived Projection cache 的 SQLite 组件。 */
  readonly #store: SqliteRunStore;

  private constructor(options: OpenRuntimeOptions) {
    // 两个 store 只能收到同一次集中准备得到的 canonical Runtime Home，避免
    // SQLite 先创建文件、Artifact Store 随后才发现 caller final path 是 symlink。
    const runtimeHome = preparePrivateRuntimeHome(options.runtimeHome);
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? uuidGenerator;
    this.#model = options.model;
    this.#artifacts = new ContentAddressedArtifactStore(runtimeHome);
    this.#store = new SqliteRunStore(runtimeHome);
  }

  public static open(options: OpenRuntimeOptions): ResearchAgentRuntime {
    return new ResearchAgentRuntime(options);
  }

  public async createRun(command: CreateRunCommand): Promise<RunProjection> {
    const parsed = createRunCommandSchema.parse(command);
    let sourceScope: SourceScope;
    try {
      const requestedSourceScope = parseRequestedSourceScope(parsed.sourceScope);
      sourceScope = await canonicalizeSourceScope(requestedSourceScope);
    } catch (error) {
      if (
        error instanceof SourceScopeCanonicalizationError ||
        error instanceof z.ZodError
      ) {
        throw new InvalidSourceScopeError();
      }
      throw error;
    }
    const runBudget = parseRunBudget(parsed.runBudget);
    const runId = this.#ids.nextRunId();
    const createdAt = this.#clock.now();

    const initialEvents: ResearchRunEvent[] = [
      {
        eventId: this.#ids.nextEventId(),
        runId,
        sequence: 1,
        type: "run_created",
        occurredAt: createdAt,
        payload: { question: parsed.question, sourceScope, runBudget },
      },
      {
        eventId: this.#ids.nextEventId(),
        runId,
        sequence: 2,
        type: "planning_started",
        occurredAt: createdAt,
        payload: {},
      },
    ];
    this.#store.appendEvents(runId, 0, initialEvents);

    // Model 调用位于数据库短事务之外，避免用 SQLite 写锁包住不可预测的外部延迟。
    // 若调用失败，Run 仍可从 planning 状态被 inspect；显式失败语义将在 ticket #7 加入。
    const plan = parseResearchPlan(
      await this.#model.proposePlan({
        runId,
        question: parsed.question,
        sourceScope,
      }),
    );
    const proposedAt = this.#clock.now();
    const artifact = await this.#artifacts.putJson(
      plan,
      "application/json",
      proposedAt,
    );
    const approvalBinding = createPlanApprovalBinding({
      question: parsed.question,
      planHash: artifact.sha256,
      sourceScope,
      runBudget,
    });
    const planProposed: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: 3,
      type: "plan_proposed",
      occurredAt: proposedAt,
      payload: { planArtifact: artifact, approvalBinding },
    };

    return this.#store.appendEvents(runId, 2, [planProposed], [artifact]);
  }

  public async inspectRun(command: InspectRunCommand): Promise<RunProjection> {
    const { runId } = runIdentityCommandSchema.parse(command);
    return this.#store.readProjection(runId);
  }

  public async approvePlan(
    command: ApprovePlanCommand,
  ): Promise<RunProjection> {
    const parsedCommand = approvePlanCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new InvalidPlanApprovalCommandError();
    }
    const { runId, bindingHash } = parsedCommand.data;
    const current = this.#store.readProjection(runId);

    // 幂等判断必须发生在生成 Approval Receipt 或 event identity 之前；否则同一
    // 用户命令的安全重试会消耗新 identity，并可能制造第二个授权事实。
    if (
      current.state.type === "researching" &&
      current.state.approvalReceipt.bindingHash === bindingHash
    ) {
      return current;
    }
    if (current.state.type !== "waiting_plan_approval") {
      throw new IllegalPlanApprovalStateError(current.state.type);
    }

    // stale hash 一律 fail closed；错误不回显期望值、提交值、计划内容或 Source
    // Scope，避免把审批边界当作诊断 payload 泄露出去。
    if (bindingHash !== current.state.approvalBinding.bindingHash) {
      throw new StalePlanApprovalError();
    }

    const approvedAt = this.#clock.now();
    const approvalReceipt = {
      approvalId: this.#ids.nextApprovalId(),
      kind: "plan",
      approvedBy: "user-command",
      approvedAt,
      ...current.state.approvalBinding,
    } as const;
    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: current.lastEventSequence + 1,
      type: "plan_approved",
      occurredAt: approvedAt,
      payload: { approvalReceipt },
    };

    // Approval 是独立用户命令，不接受模型输出、Research Tool 参数、环境变量或
    // 调用方自造 Receipt；这里使用读取时的 last sequence 保留乐观并发语义。
    try {
      return this.#store.appendEvents(
        runId,
        current.lastEventSequence,
        [event],
      );
    } catch (error) {
      if (!(error instanceof ConcurrentRunWriteError)) {
        throw error;
      }

      const persisted = this.#store.readProjection(runId);
      if (
        persisted.state.type === "researching" &&
        persisted.state.approvalReceipt.bindingHash === bindingHash
      ) {
        // 两个 process-like 命令都可能在竞争前消费 clock/ID，但只有赢家事件成为
        // durable fact；输家重读同一 Receipt 即实现语义幂等。尝试态 identity 不写
        // Journal，也不值得提前引入 Issue #10 的 durable operation 协议。
        return persisted;
      }

      throw new PlanApprovalConflictError();
    }
  }

  public async traceRun(command: TraceRunCommand): Promise<RunTrace> {
    const { runId } = runIdentityCommandSchema.parse(command);
    return buildRunTrace(this.#store.readEvents(runId));
  }

  public async readSource(command: ReadSourceCommand): Promise<RunProjection> {
    const parsedCommand = readSourceCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      // caller 可能把 secret path 或自造 authority 塞进错误输入；错误边界不回显。
      throw new InvalidSourceReadCommandError();
    }
    const { runId, request } = parsedCommand.data;
    let current: RunProjection;
    try {
      current = this.#store.readProjection(runId);
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        throw new SourceReadRunNotFoundError();
      }
      // Journal/schema/cache/SQLite 诊断属于私有运行时细节，可能包含持久化
      // payload 或 identity；readSource 的公开错误边界不把它们转交给调用方。
      throw new SourceReadPersistenceError();
    }
    if (current.state.type !== "researching") {
      throw new IllegalSourceReadStateError();
    }

    const approvedByteLimit = Math.min(
      current.sourceScope.maxTotalBytes,
      current.runBudget.maxSourceBytes,
    );
    const remainingSourceBytes = Math.max(
      0,
      approvedByteLimit - current.state.sourceBytesRead,
    );
    const requestHash = hashReadSourceRequest(request);
    const access = new PrivateSourceAccess(current.sourceScope);
    const result = await access.capture(request, remainingSourceBytes);
    const observedAt = this.#clock.now();
    const lineage = {
      observationId: this.#ids.nextObservationId(),
      toolCallId: this.#ids.nextToolCallId(),
      toolName: "read_source",
      requestHash,
      observedAt,
    } as const;

    let observation: SourceReadObservation;
    let persistedSourceSnapshot: PersistedSourceSnapshot | undefined;
    if (result.status === "captured") {
      try {
        // 文件 I/O 与私有 CAS 都位于 SQLite 短事务之外。只有下面 registry 与
        // Journal 同时提交后，Run 才能声称这次观察是 durable fact。
        persistedSourceSnapshot = this.#store.prepareSourceSnapshotRegistration(
          await this.#artifacts.putSourceSnapshot(
            result.fullBytes,
            observedAt,
          ),
        );
      } catch {
        throw new SourceReadPersistenceError();
      }
      const {
        createdAt: _registryCreatedAt,
        ...sourceSnapshotReference
      } = persistedSourceSnapshot;
      observation = {
        ...lineage,
        status: "succeeded",
        rootIndex: result.rootIndex,
        relativePath: result.relativePath,
        startLine: result.startLine,
        endLine: result.endLine,
        totalLines: result.totalLines,
        excerpt: result.excerpt,
        excerptHash: hashUtf8Text(result.excerpt),
        sourceSnapshot: sourceSnapshotReference,
        byteLength: result.byteLength,
      };
    } else if (result.status === "denied") {
      // denial/failure 本身也是解释“为什么没有证据”的 Journal 事实；只保留
      // request hash 与稳定 code，不落 raw path、OS error 或任何 snapshot。
      observation = {
        ...lineage,
        status: "denied",
        code: result.code,
      };
    } else {
      observation = {
        ...lineage,
        status: "failed",
        code: result.code,
      };
    }

    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: current.lastEventSequence + 1,
      type: "source_read_observed",
      occurredAt: observedAt,
      payload: { observation },
    };

    try {
      return this.#store.appendEvents(
        runId,
        current.lastEventSequence,
        [event],
        [],
        persistedSourceSnapshot === undefined ? [] : [persistedSourceSnapshot],
      );
    } catch (error) {
      if (error instanceof ConcurrentRunWriteError) {
        // CAS bytes 可能已在冲突前原子落盘，成为可由未来 GC 回收的 orphan；
        // Journal 仍是事实源，冲突后绝不能重读 live file 或伪称 observation 已提交。
        throw new SourceReadConflictError();
      }
      if (error instanceof SourceSnapshotRegistrationError) {
        throw new SourceReadPersistenceError();
      }
      // 基础设施、schema 或 reducer 诊断可能携带内部 identity；公开命令只给出
      // 稳定安全错误，不把 Runtime Home、hash、payload 或 SQLite 细节外泄。
      throw new SourceReadPersistenceError();
    }
  }

  public async recordEvidence(
    command: RecordEvidenceCommand,
  ): Promise<RunProjection> {
    const parsedCommand = recordEvidenceCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new InvalidEvidenceCommandError();
    }
    const { runId, observationId } = parsedCommand.data;
    let current: RunProjection;
    try {
      current = this.#store.readProjection(runId);
    } catch {
      throw new EvidencePersistenceError();
    }
    if (current.state.type !== "researching") {
      throw new IllegalEvidenceStateError();
    }
    const researching = current.state;

    const observation = researching.sourceReadObservations.find(
      (candidate) => candidate.observationId === observationId,
    );
    if (observation?.status !== "succeeded") {
      // 只有 Journal 已经承认、并成功绑定 Source Snapshot 的读取才能成为
      // Evidence；调用方不能从路径、摘录或失败 observation 自造事实。
      throw new EvidenceObservationNotAvailableError();
    }
    if (
      researching.evidenceRecords.some(
        (evidence) => evidence.observationId === observation.observationId,
      )
    ) {
      throw new EvidenceObservationNotAvailableError();
    }

    const occurredAt = this.#clock.now();
    const eventId = this.#ids.nextEventId();
    const evidence: EvidenceRecord = {
      // 与 event identity 一起生成可避免给注入 ID port 增加另一套可失配的计数器；
      // event 本身仍是唯一持久化事实，Evidence ID 只是在该事实上的稳定引用。
      evidenceId: `evidence-${eventId}`,
      kind: "source_fact",
      observationId: observation.observationId,
      toolCallId: observation.toolCallId,
      sourceSnapshotId: observation.sourceSnapshot.snapshotId,
      rootIndex: observation.rootIndex,
      relativePath: observation.relativePath,
      startLine: observation.startLine,
      endLine: observation.endLine,
      excerptHash: observation.excerptHash,
      recordedAt: occurredAt,
    };
    const event: ResearchRunEvent = {
      eventId,
      runId,
      sequence: current.lastEventSequence + 1,
      type: "evidence_recorded",
      occurredAt,
      payload: { evidence },
    };

    try {
      return this.#store.appendEvents(runId, current.lastEventSequence, [event]);
    } catch (error) {
      if (error instanceof ConcurrentRunWriteError) {
        throw new EvidenceWriteConflictError();
      }
      throw new EvidencePersistenceError();
    }
  }

  public async recordClaim(command: RecordClaimCommand): Promise<RunProjection> {
    const parsedCommand = recordClaimCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new InvalidClaimCommandError();
    }
    const { runId, text, evidenceIds } = parsedCommand.data;
    let current: RunProjection;
    try {
      current = this.#store.readProjection(runId);
    } catch {
      throw new EvidencePersistenceError();
    }
    if (current.state.type !== "researching") {
      throw new IllegalEvidenceStateError();
    }
    const researching = current.state;
    if (
      new Set(evidenceIds).size !== evidenceIds.length ||
      !evidenceIds.every((evidenceId) =>
        researching.evidenceRecords.some(
          (evidence) => evidence.evidenceId === evidenceId,
        ),
      )
    ) {
      throw new ClaimEvidenceNotAvailableError();
    }

    const occurredAt = this.#clock.now();
    const eventId = this.#ids.nextEventId();
    const claim: Claim = {
      claimId: `claim-${eventId}`,
      text,
      evidenceIds,
      recordedAt: occurredAt,
    };
    const event: ResearchRunEvent = {
      eventId,
      runId,
      sequence: current.lastEventSequence + 1,
      type: "claim_recorded",
      occurredAt,
      payload: { claim },
    };

    try {
      return this.#store.appendEvents(runId, current.lastEventSequence, [event]);
    } catch (error) {
      if (error instanceof ConcurrentRunWriteError) {
        throw new EvidenceWriteConflictError();
      }
      throw new EvidencePersistenceError();
    }
  }

  public async rebuildRunProjection(
    command: RebuildRunProjectionCommand,
  ): Promise<RunProjection> {
    const { runId } = runIdentityCommandSchema.parse(command);
    return this.#store.rebuildProjection(runId);
  }

  public close(): void {
    this.#store.close();
  }
}
