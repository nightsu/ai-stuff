import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  createPlanApprovalBinding,
  hashReadSourceRequest,
  hashUtf8Text,
} from "../domain/integrity.js";
import {
  assertEvidenceGateBudget,
  EvidenceGateError,
  evaluateEvidenceGate,
} from "../domain/evidence-gate.js";
import {
  calculateRemainingRunBudget,
  countLogicalToolCalls,
  firstExhaustedRunBudgetDimension,
  RunBudgetCalculationError,
} from "../domain/run-budget.js";
import {
  createPublicationApprovalBinding,
  renderLearningArtifact,
} from "../domain/learning-artifact.js";
import { hasPreRenderedCitationToken } from "../domain/citation-safety.js";
import { buildRunTrace } from "../domain/reducer.js";
import {
  parseResearchPlan,
  parseLearningArtifactProposal,
  readSourceRequestSchema,
  parseRequestedSourceScope,
  parseRunBudget,
} from "../domain/schemas.js";
import type {
  ArtifactReference,
  Claim,
  EvidenceRecord,
  LearningArtifactProposal,
  PublicationApprovalReceipt,
  PublicationTarget,
  ResearchRunEvent,
  PersistedSourceSnapshot,
  PersistedArtifact,
  ReadSourceRequest,
  RunProjection,
  RunTrace,
  SourceSearchMatch,
  SourceReadObservation,
  SourceScope,
  ModelTurn,
  ModelView,
  ModelViewResearchToolObservation,
  ResearchPlan,
  ResearchToolIntent,
  ResearchToolObservation,
  RemainingRunBudget,
  SucceededSourceReadObservation,
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
import {
  LearningArtifactPublisher,
  PublicationTargetPreparationError,
} from "../infrastructure/learning-artifact-publisher.js";
import { RgSourceSearch } from "../infrastructure/private-source-search.js";
import type { Clock, IdGenerator, ModelPort, SourceSearchPort } from "./ports.js";

/** 打开一个 headless runtime 所需的基础设施与可控边界。 */
export interface OpenRuntimeOptions {
  /** 私有且应被 git ignore 的 Runtime Home 路径。 */
  readonly runtimeHome: string;
  /** 可发布 Markdown 的唯一边界；省略时 Runtime 仍可研究，但不能提出 publication draft。 */
  readonly outputRoot?: string;
  /** 计划生成使用的 Model Port；inspect 与 trace 不会调用它。 */
  readonly model: ModelPort;
  /** 可选时间边界；生产默认使用系统 UTC 时间。 */
  readonly clock?: Clock;
  /** 可选 identity 边界；生产默认使用 UUID。 */
  readonly ids?: IdGenerator;
  /** 可选 Source Search Port；测试可替换 host `rg` 与 discovery 故障。 */
  readonly sourceSearch?: SourceSearchPort;
  /** 单个 Model View 允许的确定性 JSON UTF-8 字节数；不足以容纳 pinned facts 时暂停。 */
  readonly maxModelViewBytes?: number;
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
  /** 当前 slice 明确只接纳直接由来源 Evidence 支持的 source fact。 */
  readonly kind: "source_fact";
  /** 不包含预渲染 citation 的简短、非空 Claim 文本。 */
  readonly text: string;
  /** 至少一个既有 Evidence identity，顺序是未来渲染的显式引用顺序。 */
  readonly evidenceIds: readonly string[];
}

/** 从 canonical facts 推进有界 Research Loop 的应用命令。 */
export interface AdvanceResearchCommand {
  /** 当前必须处于 researching 的 Research Run identity。 */
  readonly runId: string;
  /** 本次推进要固定进 Model View 的最新用户 steering；空白值会被拒绝。 */
  readonly steering?: string;
}

/** 让模型在既有 Evidence-backed Claims 中选择 Markdown draft 的应用命令。 */
export interface ProposeLearningArtifactCommand {
  /** 当前必须处于 researching 的 Research Run identity。 */
  readonly runId: string;
  /** 必须为 Output Root 内的绝对 Markdown 路径；Runtime 会捕获 root 与 parent identity。 */
  readonly targetPath: string;
}

/** 用用户可见 publication binding 批准 exact draft 和 target 的应用命令。 */
export interface ApprovePublicationCommand {
  /** 当前必须等待 publication approval 的 Research Run identity。 */
  readonly runId: string;
  /** 用户从等待 Projection 原样提交的聚合 publication binding hash。 */
  readonly bindingHash: string;
}

/** 在 durable publication approval 后执行一次正常 no-clobber 写入的应用命令。 */
export interface PublishLearningArtifactCommand {
  /** 当前必须处于 ready_to_publish 的 Research Run identity。 */
  readonly runId: string;
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

/** Learning Artifact draft 命令不满足严格输入契约时抛出的安全错误。 */
export class InvalidLearningArtifactCommandError extends Error {
  public constructor() {
    super("Learning Artifact 命令格式无效");
    this.name = "InvalidLearningArtifactCommandError";
  }
}

/** 不能在当前 Run 状态提出 Evidence-backed draft 时抛出的安全错误。 */
export class IllegalLearningArtifactStateError extends Error {
  public constructor() {
    super("当前 Research Run 状态不能提出 Learning Artifact draft");
    this.name = "IllegalLearningArtifactStateError";
  }
}

/** Evidence Gate 未通过时阻止私有 draft 或外部 publication 的安全错误。 */
export class EvidenceGateBlockedError extends Error {
  public constructor() {
    super("Learning Artifact 缺少有效 Evidence 支持");
    this.name = "EvidenceGateBlockedError";
  }
}

/** 模型提案或私有 draft 无法安全生成时抛出的 payload-safe 错误。 */
export class LearningArtifactDraftError extends Error {
  public constructor() {
    super("Learning Artifact draft 无法安全生成");
    this.name = "LearningArtifactDraftError";
  }
}

/** draft Journal 追加与另一项 Run 更新冲突时抛出的安全错误。 */
export class LearningArtifactDraftConflictError extends Error {
  public constructor() {
    super("Learning Artifact draft 与另一项 Run 更新发生冲突");
    this.name = "LearningArtifactDraftConflictError";
  }
}

/** publication approval 命令不满足严格输入契约时抛出的安全错误。 */
export class InvalidPublicationApprovalCommandError extends Error {
  public constructor() {
    super("publication approval 命令格式无效");
    this.name = "InvalidPublicationApprovalCommandError";
  }
}

/** 旧 binding 或已改变 target identity 不能再授权 publication 时抛出的安全错误。 */
export class StalePublicationApprovalError extends Error {
  public constructor() {
    super("publication approval 已过期或与当前等待版本不匹配");
    this.name = "StalePublicationApprovalError";
  }
}

/** 非等待状态收到 publication approval 时抛出的安全状态错误。 */
export class IllegalPublicationApprovalStateError extends Error {
  public constructor() {
    super("当前 Research Run 状态不能接受 publication approval");
    this.name = "IllegalPublicationApprovalStateError";
  }
}

/** publication approval 追加与另一项 Run 更新冲突时抛出的安全错误。 */
export class PublicationApprovalConflictError extends Error {
  public constructor() {
    super("publication approval 与另一项 Run 更新发生冲突");
    this.name = "PublicationApprovalConflictError";
  }
}

/** 非 ready_to_publish 状态收到 publication 命令时抛出的安全状态错误。 */
export class IllegalLearningArtifactPublicationStateError extends Error {
  public constructor() {
    super("当前 Research Run 状态不能发布 Learning Artifact");
    this.name = "IllegalLearningArtifactPublicationStateError";
  }
}

/** publisher 或 published Journal 写入失败被消毒后的公开错误。 */
export class LearningArtifactPublicationError extends Error {
  public constructor() {
    super("Learning Artifact 无法安全发布");
    this.name = "LearningArtifactPublicationError";
  }
}

/** Research Loop 无法从 canonical facts 安全推进时抛出的稳定应用错误。 */
export class ResearchLoopError extends Error {
  public constructor() {
    super("Research Loop 无法安全推进");
    this.name = "ResearchLoopError";
  }
}

/** 确定性裁剪后仍无法容纳 pinned Model View 时抛出的显式停止错误。 */
export class ModelViewTooLargeError extends Error {
  public constructor() {
    super("Model View 在确定性裁剪后仍超出上下文预算");
    this.name = "ModelViewTooLargeError";
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
    kind: z.literal("source_fact"),
    text: z
      .string()
      .trim()
      .min(1)
      .refine(
        (text) => !hasPreRenderedCitationToken(text),
        "Claim 不能包含预渲染 citation",
      ),
    evidenceIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const proposeLearningArtifactCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    targetPath: z.string().trim().min(1),
  })
  .strict();

const approvePublicationCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const publishLearningArtifactCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
  })
  .strict();

const advanceResearchCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    steering: z.string().trim().min(1).optional(),
  })
  .strict();

const researchTurnOutputSchema = z
  .object({
    text: z.string(),
    evidenceGaps: z.array(z.string().trim().min(1)),
    finishReason: z.enum(["tool_calls", "stop"]),
    toolIntents: z
      .array(
        z
          .object({
            intentId: z.string().trim().min(1),
            name: z.enum([
              "search_sources",
              "read_source",
              "record_evidence",
              "propose_claim",
              "complete_research",
            ]),
            input: z.json(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const searchSourcesInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().positive().max(50),
  })
  .strict();

const recordEvidenceInputSchema = z
  .object({ observationId: z.string().trim().min(1) })
  .strict();

const proposeClaimInputSchema = z
  .object({
    kind: z.literal("source_fact"),
    text: z.string().trim().min(1),
    evidenceIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const completeResearchInputSchema = z
  .object({ unresolvedQuestions: z.array(z.string().trim().min(1)) })
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

/** 去除 registry-only 时间字段，保证 Journal artifact 引用只保存可回放身份与内容元数据。 */
function stripArtifactCreatedAt(artifact: PersistedArtifact): ArtifactReference {
  const { createdAt: _createdAt, ...reference } = artifact;
  return reference;
}

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
  /** 只接收 exact target binding 与 Markdown bytes 的外部 publication 边界。 */
  readonly #publisher: LearningArtifactPublisher;
  /** 执行模型可见 `search_sources` 且可由测试注入的 discovery 边界。 */
  readonly #sourceSearch: SourceSearchPort;
  /** 不依赖 tokenizer/provider 的确定性 JSON byte 上限。 */
  readonly #maxModelViewBytes: number;

  private constructor(options: OpenRuntimeOptions) {
    // 两个 store 只能收到同一次集中准备得到的 canonical Runtime Home，避免
    // SQLite 先创建文件、Artifact Store 随后才发现 caller final path 是 symlink。
    const runtimeHome = preparePrivateRuntimeHome(options.runtimeHome);
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? uuidGenerator;
    this.#model = options.model;
    this.#maxModelViewBytes = options.maxModelViewBytes ?? 32_768;
    this.#artifacts = new ContentAddressedArtifactStore(runtimeHome);
    this.#store = new SqliteRunStore(runtimeHome);
    this.#publisher = new LearningArtifactPublisher({
      runtimeHome,
      ...(options.outputRoot === undefined
        ? {}
        : { outputRoot: options.outputRoot }),
    });
    this.#sourceSearch = options.sourceSearch ?? new RgSourceSearch();
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

  public async advanceResearch(
    command: AdvanceResearchCommand,
  ): Promise<RunProjection> {
    const parsedCommand = advanceResearchCommandSchema.safeParse(command);
    if (!parsedCommand.success || this.#model.generateResearchTurn === undefined) {
      throw new ResearchLoopError();
    }
    const { runId, steering } = parsedCommand.data;

    // 每个迭代只做三件事：从 Journal 重建视图、提交一个完整 Model Turn、
    // 顺序消费其 intents。任何一步崩溃后，canonical Projection 都能指出是该
    // 重新 generation，还是先完成已经 durable 的 pending intent。
    while (true) {
      const current = this.#store.readProjection(runId);
      if (
        current.state.type === "research_complete" ||
        current.state.type === "budget_exhausted"
      ) {
        return current;
      }
      if (current.state.type !== "researching") {
        throw new ResearchLoopError();
      }
      const now = this.#clock.now();
      const remainingBudget = this.#remainingBudget(current, now);
      const exhausted = firstExhaustedRunBudgetDimension(
        remainingBudget,
        current.state.pendingToolIntents.length === 0 ? "model" : "tool",
      );
      if (exhausted !== undefined) {
        return this.#suspendForBudget(current, exhausted);
      }
      if (current.state.pendingToolIntents.length !== 0) {
        await this.#executePendingResearchIntent(current);
        continue;
      }

      const approvedPlan = parseResearchPlan(
        await this.#artifacts.readJson(current.state.planArtifact),
      );
      const view = this.#fitModelView(await this.#buildModelView(
        current,
        approvedPlan,
        remainingBudget,
        steering ?? current.state.latestSteering,
      ));
      let generated: z.infer<typeof researchTurnOutputSchema>;
      try {
        generated = researchTurnOutputSchema.parse(
          await this.#model.generateResearchTurn(view),
        );
      } catch {
        throw new ResearchLoopError();
      }
      const occurredAt = this.#clock.now();
      const eventId = this.#ids.nextEventId();
      const turn: ModelTurn = {
        turnId: `turn-${eventId}`,
        ...generated,
        completedAt: occurredAt,
      };
      const event: ResearchRunEvent = {
        eventId,
        runId,
        sequence: current.lastEventSequence + 1,
        type: "model_turn_completed",
        occurredAt,
        payload: {
          turn,
          generationStartedAt: now,
          ...(steering === undefined ? {} : { latestSteering: steering }),
        },
      };
      try {
        this.#store.appendEvents(runId, current.lastEventSequence, [event]);
      } catch {
        throw new ResearchLoopError();
      }
    }
  }

  async #buildModelView(
    current: RunProjection,
    approvedPlan: ResearchPlan,
    remainingBudget: RemainingRunBudget,
    latestSteering: string | undefined,
  ): Promise<ModelView> {
    if (
      current.state.type !== "researching" &&
      current.state.type !== "research_complete"
    ) {
      throw new ResearchLoopError();
    }
    const researching = current.state;
    const relevantEvidence = researching.evidenceRecords.map((evidence) => {
      const observation = researching.sourceReadObservations.find(
        (candidate): candidate is SucceededSourceReadObservation =>
          candidate.status === "succeeded" &&
          candidate.observationId === evidence.observationId,
      );
      if (observation === undefined) throw new ResearchLoopError();
      return {
        evidenceId: evidence.evidenceId,
        relativePath: evidence.relativePath,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        excerpt: observation.excerpt,
      };
    });
    const recentObservations = await Promise.all(
      researching.researchToolObservations.slice(-8).map(async (
        observation,
      ): Promise<ModelViewResearchToolObservation> => {
        const output = observation.output;
        if (output === undefined) {
          return { ...observation, output: undefined };
        }
        if (!("searchResultArtifact" in output)) {
          return { ...observation, output };
        }
        let matches: SourceSearchMatch[];
        try {
          matches = parseSourceSearchMatches(
            await this.#artifacts.readJson(output.searchResultArtifact),
          );
        } catch {
          // Journal 只能证明 search artifact identity；若私有 CAS 丢失或损坏，
          // Harness 不得用空结果继续 generation 并把恢复故障伪装成“没有命中”。
          throw new ResearchLoopError();
        }
        if (matches.length !== output.matchCount) {
          throw new ResearchLoopError();
        }
        return { ...observation, output: { matches } };
      }),
    );
    return {
      runId: current.runId,
      question: current.question,
      fixedRules: [
        "只能使用五个 Research Tools，不能请求 shell、publication 或预算变更。",
        "Evidence 和 Claim identities 只能来自 Harness observations。",
        "完成研究必须显式调用 complete_research 并保留未解决问题。",
      ],
      approvedPlan,
      approvalBindingHash: current.state.approvalReceipt.bindingHash,
      budgetVersion: current.runBudget.version,
      remainingBudget,
      evidenceGaps: current.state.evidenceGaps,
      pendingIntents: current.state.pendingToolIntents,
      relevantEvidence,
      recentObservations,
      ...(latestSteering === undefined ? {} : { latestSteering }),
    };
  }

  #fitModelView(view: ModelView): ModelView {
    let candidate = view;
    while (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") >
        this.#maxModelViewBytes &&
      candidate.recentObservations.length > 0
    ) {
      candidate = {
        ...candidate,
        recentObservations: candidate.recentObservations.slice(1),
      };
    }
    while (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") >
        this.#maxModelViewBytes &&
      candidate.relevantEvidence.length > 0
    ) {
      candidate = {
        ...candidate,
        relevantEvidence: candidate.relevantEvidence.slice(0, -1),
      };
    }
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") >
      this.#maxModelViewBytes
    ) {
      // fixed rules、批准计划、审批/预算、pending intents、gaps 与 steering 都是
      // pinned facts。宁可明确停止，也不能用 LLM 摘要或静默删约束来“适配”窗口。
      throw new ModelViewTooLargeError();
    }
    return candidate;
  }

  async #executePendingResearchIntent(current: RunProjection): Promise<void> {
    if (current.state.type !== "researching") throw new ResearchLoopError();
    const intent = current.state.pendingToolIntents[0];
    if (intent === undefined) return;
    switch (intent.name) {
      case "search_sources":
        await this.#executeSearchIntent(current, intent);
        return;
      case "read_source":
        await this.#executeReadIntent(current, intent);
        return;
      case "record_evidence":
        await this.#executeEvidenceIntent(current, intent);
        return;
      case "propose_claim":
        await this.#executeClaimIntent(current, intent);
        return;
      case "complete_research":
        await this.#executeCompletionIntent(current, intent);
        return;
    }
  }

  async #executeSearchIntent(
    current: RunProjection,
    intent: ResearchToolIntent,
  ): Promise<void> {
    const parsed = searchSourcesInputSchema.safeParse(intent.input);
    if (!parsed.success) {
      this.#appendGenericToolObservation(current, intent, "invalid", "invalid_tool_schema");
      return;
    }
    try {
      const matches = await this.#sourceSearch.search(
        current.sourceScope,
        parsed.data,
      );
      const observedAt = this.#clock.now();
      const artifact = await this.#artifacts.putJson(
        matches,
        "application/json",
        observedAt,
      );
      const observation = this.#createResearchObservation(
        intent,
        "succeeded",
        undefined,
        `找到 ${matches.length} 个批准来源命中`,
        {
          searchResultArtifact: stripArtifactCreatedAt(artifact),
          matchCount: matches.length,
        },
        observedAt,
      );
      const event: ResearchRunEvent = {
        eventId: this.#ids.nextEventId(),
        runId: current.runId,
        sequence: current.lastEventSequence + 1,
        type: "research_tool_observed",
        occurredAt: observedAt,
        payload: { observation },
      };
      this.#store.appendEvents(
        current.runId,
        current.lastEventSequence,
        [event],
        [artifact],
      );
    } catch {
      this.#appendGenericToolObservation(current, intent, "failed", "search_failed");
    }
  }

  async #executeReadIntent(current: RunProjection, intent: ResearchToolIntent): Promise<void> {
    const parsed = readSourceRequestSchema.safeParse(intent.input);
    if (!parsed.success) {
      this.#appendGenericToolObservation(current, intent, "invalid", "invalid_tool_schema");
      return;
    }
    const remaining = this.#remainingBudget(current, this.#clock.now());
    if (remaining.sourceBytes === 0) {
      this.#suspendForBudget(current, "source_bytes");
      return;
    }
    await this.#readSource(
      { runId: current.runId, request: parsed.data },
      intent,
    );
  }

  async #executeEvidenceIntent(current: RunProjection, intent: ResearchToolIntent): Promise<void> {
    const parsed = recordEvidenceInputSchema.safeParse(intent.input);
    if (!parsed.success) {
      this.#appendGenericToolObservation(current, intent, "invalid", "invalid_tool_schema");
      return;
    }
    try {
      await this.#recordEvidence(
        { runId: current.runId, ...parsed.data },
        intent,
      );
    } catch {
      this.#appendGenericToolObservation(current, intent, "failed", "stale_observation");
    }
  }

  async #executeClaimIntent(current: RunProjection, intent: ResearchToolIntent): Promise<void> {
    const parsed = proposeClaimInputSchema.safeParse(intent.input);
    if (!parsed.success) {
      this.#appendGenericToolObservation(current, intent, "invalid", "invalid_tool_schema");
      return;
    }
    try {
      await this.#recordClaim(
        { runId: current.runId, ...parsed.data },
        intent,
      );
    } catch {
      this.#appendGenericToolObservation(current, intent, "failed", "claim_rejected");
    }
  }

  async #executeCompletionIntent(current: RunProjection, intent: ResearchToolIntent): Promise<void> {
    const parsed = completeResearchInputSchema.safeParse(intent.input);
    if (!parsed.success) {
      this.#appendGenericToolObservation(current, intent, "invalid", "invalid_tool_schema");
      return;
    }
    if (current.state.type !== "researching" || current.state.pendingToolIntents.length !== 1) {
      this.#appendGenericToolObservation(
        current,
        intent,
        "invalid",
        "completion_not_last",
      );
      return;
    }
    const occurredAt = this.#clock.now();
    const observation = this.#createResearchObservation(
      intent,
      "succeeded",
      undefined,
      `研究显式完成，保留 ${parsed.data.unresolvedQuestions.length} 个未解决问题`,
      { unresolvedQuestions: parsed.data.unresolvedQuestions },
      occurredAt,
    );
    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId: current.runId,
      sequence: current.lastEventSequence + 1,
      type: "research_completed",
      occurredAt,
      payload: {
        completion: { ...parsed.data, completedAt: occurredAt },
        observation,
      },
    };
    this.#store.appendEvents(current.runId, current.lastEventSequence, [event]);
  }

  #appendResearchObservationOnly(
    current: RunProjection,
    observation: ResearchToolObservation,
  ): RunProjection {
    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId: current.runId,
      sequence: current.lastEventSequence + 1,
      type: "research_tool_observed",
      occurredAt: observation.observedAt,
      payload: { observation },
    };
    return this.#store.appendEvents(current.runId, current.lastEventSequence, [event]);
  }

  #appendGenericToolObservation(
    current: RunProjection,
    intent: ResearchToolIntent,
    status: ResearchToolObservation["status"],
    code?: string,
    summary = `${intent.name} ${status}${code === undefined ? "" : `: ${code}`}`,
    output?: ResearchToolObservation["output"],
  ): RunProjection {
    return this.#appendResearchObservationOnly(
      current,
      this.#createResearchObservation(intent, status, code, summary, output),
    );
  }

  #createResearchObservation(
    intent: ResearchToolIntent,
    status: ResearchToolObservation["status"],
    code: string | undefined,
    summary: string,
    output?: ResearchToolObservation["output"],
    observedAt = this.#clock.now(),
  ): ResearchToolObservation {
    return {
      observationId: this.#ids.nextObservationId(),
      toolCallId: this.#ids.nextToolCallId(),
      intentId: intent.intentId,
      toolName: intent.name,
      status,
      ...(code === undefined ? {} : { code }),
      summary,
      ...(output === undefined ? {} : { output }),
      observedAt,
    };
  }

  #remainingBudget(current: RunProjection, evaluatedAt: string): RemainingRunBudget {
    if (
      current.state.type !== "researching" &&
      current.state.type !== "research_complete" &&
      current.state.type !== "budget_exhausted"
    ) {
      throw new ResearchLoopError();
    }
    try {
      return calculateRemainingRunBudget({
        runBudget: current.runBudget,
        state: current.state,
        evaluatedAt,
      });
    } catch (error) {
      if (error instanceof RunBudgetCalculationError) {
        throw new ResearchLoopError();
      }
      throw error;
    }
  }

  #suspendForBudget(
    current: RunProjection,
    exhaustedDimension: "model_turns" | "tool_calls" | "distinct_sources" | "source_bytes" | "wall_time",
  ): RunProjection {
    const occurredAt = this.#clock.now();
    // payload 必须用 event 自己的 occurredAt 重算；若复用更早一拍的 Model View
    // 余额，真实递增时钟会让 reducer replay 得到不同 wall-time 并拒绝事件。
    const remainingBudget = this.#remainingBudget(current, occurredAt);
    return this.#store.appendEvents(current.runId, current.lastEventSequence, [
      {
        eventId: this.#ids.nextEventId(),
        runId: current.runId,
        sequence: current.lastEventSequence + 1,
        type: "run_budget_exhausted",
        occurredAt,
        payload: { exhaustedDimension, remainingBudget },
      },
    ]);
  }

  public async readSource(command: ReadSourceCommand): Promise<RunProjection> {
    return this.#readSource(command);
  }

  async #readSource(
    command: ReadSourceCommand,
    researchIntent?: ResearchToolIntent,
  ): Promise<RunProjection> {
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
    if (
      current.state.type !== "researching" &&
      current.state.type !== "research_complete"
    ) {
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
      payload: {
        observation,
        ...(researchIntent === undefined
          ? {}
          : {
              researchObservation: {
                observationId: observation.observationId,
                toolCallId: observation.toolCallId,
                intentId: researchIntent.intentId,
                toolName: "read_source",
                status: observation.status,
                ...(observation.status === "succeeded"
                  ? {
                      summary: `读取 ${observation.relativePath}:${observation.startLine}-${observation.endLine} 成功`,
                      output: {
                        sourceObservationId: observation.observationId,
                      },
                    }
                  : {
                      code: observation.code,
                      summary: `read_source ${observation.status}: ${observation.code}`,
                    }),
                observedAt,
              },
            }),
      },
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
    return this.#recordEvidence(command);
  }

  async #recordEvidence(
    command: RecordEvidenceCommand,
    researchIntent?: ResearchToolIntent,
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
      payload: {
        evidence,
        ...(researchIntent === undefined
          ? {}
          : {
              researchObservation: this.#createResearchObservation(
                researchIntent,
                "succeeded",
                undefined,
                `已登记 Evidence ${evidence.evidenceId}`,
                { evidenceId: evidence.evidenceId },
                occurredAt,
              ),
            }),
      },
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
    return this.#recordClaim(command);
  }

  async #recordClaim(
    command: RecordClaimCommand,
    researchIntent?: ResearchToolIntent,
  ): Promise<RunProjection> {
    const parsedCommand = recordClaimCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new InvalidClaimCommandError();
    }
    const { runId, kind, text, evidenceIds } = parsedCommand.data;
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
      kind,
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
      payload: {
        claim,
        ...(researchIntent === undefined
          ? {}
          : {
              researchObservation: this.#createResearchObservation(
                researchIntent,
                "succeeded",
                undefined,
                `已登记 Claim ${claim.claimId}`,
                { claimId: claim.claimId },
                occurredAt,
              ),
            }),
      },
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

  public async proposeLearningArtifact(
    command: ProposeLearningArtifactCommand,
  ): Promise<RunProjection> {
    const parsedCommand = proposeLearningArtifactCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new InvalidLearningArtifactCommandError();
    }
    const { runId, targetPath } = parsedCommand.data;
    let current: RunProjection;
    try {
      current = this.#store.readProjection(runId);
    } catch {
      throw new LearningArtifactDraftError();
    }
    if (
      current.state.type !== "researching" &&
      current.state.type !== "research_complete"
    ) {
      throw new IllegalLearningArtifactStateError();
    }
    const researching = current.state;
    if (
      researching.modelTurns.length > 0 &&
      researching.type !== "research_complete"
    ) {
      // #5 的零 Model Turn 显式教学路径仍可独立使用；一旦进入 Research Loop，
      // deterministic outer workflow 必须看到 complete_research 的 durable fact。
      throw new IllegalLearningArtifactStateError();
    }
    if (
      researching.claims.length === 0 ||
      researching.evidenceRecords.length === 0
    ) {
      // 先执行 cheap durable gate，保证没有来源事实时既不调用模型，也不创建私有
      // draft artifact；这使“没有 Evidence 就不能 publish”成为可观察不变量。
      throw new EvidenceGateBlockedError();
    }
    if (current.runBudget.maxModelTurns < 2) {
      // 当前 one-shot slice 已经用 `proposePlan` 消耗一 turn；没有第二 turn 时
      // 不允许调用 Artifact proposal ModelPort，以免先产生未授权模型副作用。
      throw new EvidenceGateBlockedError();
    }
    if (
      current.runBudget.maxModelTurns - 1 - researching.modelTurns.length <= 0
    ) {
      // Artifact proposal 也是 Model Port generation。预算必须在调用前预留，不能
      // 先制造模型副作用，再由 Gate 在返回后发现已经超限。
      throw new EvidenceGateBlockedError();
    }

    let proposal: LearningArtifactProposal;
    let markdown: string;
    let proposedAt: string;
    try {
      proposal = parseLearningArtifactProposal(
        await this.#model.proposeLearningArtifact({
          runId,
          question: current.question,
          claims: researching.claims,
          evidenceRecords: researching.evidenceRecords,
        }),
      );
      proposedAt = this.#clock.now();
      assertEvidenceGateBudget({
        modelTurnsUsed: 2 + researching.modelTurns.length,
        toolCallsUsed: countLogicalToolCalls(
          researching.sourceReadObservations,
          researching.researchToolObservations,
        ),
        sourceReadObservations: researching.sourceReadObservations,
        runBudget: current.runBudget,
        wallTimeStartedAt:
          researching.researchStartedAt ?? current.createdAt,
        wallTimeEndedAt:
          researching.type === "research_complete"
            ? researching.completion.completedAt
            : proposedAt,
      });
      const gate = evaluateEvidenceGate(
        proposal,
        researching.claims,
        researching.evidenceRecords,
      );
      markdown = renderLearningArtifact(proposal, gate);
    } catch (error) {
      if (error instanceof EvidenceGateError) {
        throw new EvidenceGateBlockedError();
      }
      // Model adapter、Zod 与 renderer 的诊断可能回显 scripts 或 provider payload；
      // public seam 只返回稳定错误，不把模型内容当作异常文本泄露。
      throw new LearningArtifactDraftError();
    }

    let publicationTarget: PublicationTarget;
    try {
      publicationTarget = await this.#publisher.prepareTarget(targetPath);
    } catch (error) {
      if (error instanceof PublicationTargetPreparationError) {
        throw new LearningArtifactDraftError();
      }
      throw error;
    }
    let draftArtifact: PersistedArtifact;
    try {
      draftArtifact = await this.#artifacts.putMarkdown(markdown, proposedAt);
    } catch {
      throw new LearningArtifactDraftError();
    }
    const publicationBinding = createPublicationApprovalBinding({
      draftHash: draftArtifact.sha256,
      publicationTarget,
    });
    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: current.lastEventSequence + 1,
      type: "learning_artifact_draft_proposed",
      occurredAt: proposedAt,
      payload: {
        draftArtifact: stripArtifactCreatedAt(draftArtifact),
        proposal,
        publicationTarget,
        publicationBinding,
      },
    };

    try {
      return this.#store.appendEvents(
        runId,
        current.lastEventSequence,
        [event],
        [draftArtifact],
      );
    } catch (error) {
      if (error instanceof ConcurrentRunWriteError) {
        // 私有 CAS 可能已落盘但未被 Journal 引用；不能为追求幂等而再次调用模型，
        // 调用方必须先读取 canonical 状态并决定是否重新提出新的 exact draft。
        throw new LearningArtifactDraftConflictError();
      }
      throw new LearningArtifactDraftError();
    }
  }

  public async approvePublication(
    command: ApprovePublicationCommand,
  ): Promise<RunProjection> {
    const parsedCommand = approvePublicationCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new InvalidPublicationApprovalCommandError();
    }
    const { runId, bindingHash } = parsedCommand.data;
    let current: RunProjection;
    try {
      current = this.#store.readProjection(runId);
    } catch {
      throw new LearningArtifactPublicationError();
    }
    if (
      current.state.type === "ready_to_publish" &&
      current.state.publicationReceipt.bindingHash === bindingHash
    ) {
      return current;
    }
    if (current.state.type !== "waiting_publication_approval") {
      throw new IllegalPublicationApprovalStateError();
    }
    if (bindingHash !== current.state.publicationBinding.bindingHash) {
      throw new StalePublicationApprovalError();
    }

    let currentTarget;
    try {
      currentTarget = await this.#publisher.prepareTarget(
        current.state.publicationTarget.targetCanonicalPath,
      );
    } catch {
      throw new StalePublicationApprovalError();
    }
    if (
      currentTarget.targetCanonicalPath !==
        current.state.publicationTarget.targetCanonicalPath ||
      currentTarget.outputRootCanonicalPath !==
        current.state.publicationTarget.outputRootCanonicalPath ||
      currentTarget.outputRootDevice !==
        current.state.publicationTarget.outputRootDevice ||
      currentTarget.outputRootInode !==
        current.state.publicationTarget.outputRootInode ||
      currentTarget.parentDevice !== current.state.publicationTarget.parentDevice ||
      currentTarget.parentInode !== current.state.publicationTarget.parentInode
    ) {
      // 审批前 parent directory 被替换或 target 重新 canonicalize 时，旧 binding
      // 绝不能继续授权；用户必须 inspect 新 draft/target 后显式重新批准。
      throw new StalePublicationApprovalError();
    }

    const approvedAt = this.#clock.now();
    const publicationReceipt: PublicationApprovalReceipt = {
      approvalId: this.#ids.nextApprovalId(),
      kind: "publication",
      approvedBy: "user-command",
      approvedAt,
      ...current.state.publicationBinding,
    };
    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: current.lastEventSequence + 1,
      type: "publication_approved",
      occurredAt: approvedAt,
      payload: { publicationReceipt },
    };

    try {
      return this.#store.appendEvents(runId, current.lastEventSequence, [event]);
    } catch (error) {
      if (!(error instanceof ConcurrentRunWriteError)) {
        throw new LearningArtifactPublicationError();
      }
      const persisted = this.#store.readProjection(runId);
      if (
        persisted.state.type === "ready_to_publish" &&
        persisted.state.publicationReceipt.bindingHash === bindingHash
      ) {
        return persisted;
      }
      throw new PublicationApprovalConflictError();
    }
  }

  public async publishLearningArtifact(
    command: PublishLearningArtifactCommand,
  ): Promise<RunProjection> {
    const parsedCommand = publishLearningArtifactCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new InvalidLearningArtifactCommandError();
    }
    const { runId } = parsedCommand.data;
    let current: RunProjection;
    try {
      current = this.#store.readProjection(runId);
    } catch {
      throw new LearningArtifactPublicationError();
    }
    if (current.state.type === "completed") {
      return current;
    }
    if (current.state.type !== "ready_to_publish") {
      throw new IllegalLearningArtifactPublicationStateError();
    }
    const ready = current.state;
    let markdown: string;
    try {
      markdown = renderLearningArtifact(
        ready.proposal,
        evaluateEvidenceGate(
          ready.proposal,
          ready.claims,
          ready.evidenceRecords,
        ),
      );
      if (
        hashUtf8Text(markdown) !== ready.draftArtifact.sha256 ||
        Buffer.byteLength(markdown, "utf8") !== ready.draftArtifact.byteLength
      ) {
        throw new LearningArtifactPublicationError();
      }
      await this.#publisher.publish(ready.publicationTarget, markdown);
    } catch {
      // renderer、Gate 与 publisher 的内部诊断都可能暴露私有内容或路径；public
      // seam 统一映射为稳定错误，且不改变已获批准的 waiting Projection。
      throw new LearningArtifactPublicationError();
    }

    const publishedAt = this.#clock.now();
    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: current.lastEventSequence + 1,
      type: "learning_artifact_published",
      occurredAt: publishedAt,
      payload: {
        learningArtifact: {
          targetCanonicalPath: ready.publicationTarget.targetCanonicalPath,
          sha256: ready.draftArtifact.sha256,
          publishedAt,
        },
      },
    };
    try {
      return this.#store.appendEvents(runId, current.lastEventSequence, [event]);
    } catch (error) {
      if (error instanceof ConcurrentRunWriteError) {
        // 外部 bytes 已经 no-clobber 发布，后续显式相同 publish 会先验证精确 bytes
        // 再安全重试 Journal append；runtime restart 不会自动猜测该 effect 已完成。
        throw new LearningArtifactPublicationError();
      }
      throw new LearningArtifactPublicationError();
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

function parseSourceSearchMatches(value: unknown): SourceSearchMatch[] {
  return z.array(z.object({
    rootIndex: z.number().int().nonnegative(),
    relativePath: z.string().min(1),
    lineNumber: z.number().int().positive(),
    lineText: z.string(),
  }).strict()).parse(value);
}
