import type {
  Claim,
  EvidenceRecord,
  ExperimentIdentity,
  LearningArtifactProposal,
  ModelTurn,
  ModelView,
  ResearchPlan,
  SourceSearchMatch,
  SourceScope,
} from "../domain/types.js";

/** provider/search adapter 可抛出的安全基础设施失败代码。 */
export type InfrastructureFailureCode =
  | "connection_failed"
  | "rate_limited"
  | "service_unavailable"
  | "request_timeout";

/** 基础设施失败可选的安全 retry 元数据。 */
export interface InfrastructureFailureOptions {
  /** provider 建议的 retry 最短等待，单位为毫秒。 */
  readonly retryAfterMs?: number | undefined;
}

/** 端口通过此错误显式声明基础设施失败是否可由 Harness 自动 retry。 */
export class InfrastructureFailureError extends Error {
  /** 不依赖原始异常消息的稳定基础设施代码。 */
  public readonly code: InfrastructureFailureCode;
  /** provider 建议的 retry 最短等待，单位为毫秒。 */
  public readonly retryAfterMs?: number | undefined;

  public constructor(
    code: InfrastructureFailureCode,
    options: InfrastructureFailureOptions = {},
  ) {
    super("基础设施操作失败");
    this.name = "InfrastructureFailureError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Model Port 在 completed result 形成前观察到调用方取消时抛出的安全错误。 */
export class ModelGenerationAbortedError extends Error {
  public constructor() {
    super("模型 generation 已取消");
    this.name = "ModelGenerationAbortedError";
  }
}

/** 为运行时提供可注入时间的边界。 */
export interface Clock {
  /** 返回当前时间的 ISO 8601 UTC 字符串。 */
  now(): string;
}

/** Harness 在两个物理 attempts 之间执行可注入等待的边界。 */
export interface RetryScheduler {
  /** 等待严格非负整数毫秒；测试实现可以只记录而不真实阻塞。 */
  wait(delayMs: number): Promise<void>;
}

/** 为 canonical identity 提供可注入生成策略的边界。 */
export interface IdGenerator {
  /** 生成一个新的 Research Run identity。 */
  nextRunId(): string;
  /** 生成一个新的 Run Journal event identity。 */
  nextEventId(): string;
  /** 生成一个新的 durable Approval Receipt identity。 */
  nextApprovalId(): string;
  /** 生成一个新的内部 Research Tool call identity。 */
  nextToolCallId(): string;
  /** 生成一个新的 Source Read Observation identity。 */
  nextObservationId(): string;
}

/** 生成计划时提供给 Model Port 的 provider-neutral 输入。 */
export interface PlanRequest {
  /** 当前 Research Run identity，便于模型适配器记录关联。 */
  readonly runId: string;
  /** 用户提交并去除首尾空白后的技术问题。 */
  readonly question: string;
  /** 本次计划被授权考虑的 Source Scope。 */
  readonly sourceScope: SourceScope;
}

/** 为 Learning Artifact 提案提供给 Model Port 的最小、已结构化事实视图。 */
export interface LearningArtifactProposalRequest {
  /** 当前 Research Run identity，便于模型适配器记录关联。 */
  readonly runId: string;
  /** 用户最初提交并已持久化的技术问题。 */
  readonly question: string;
  /** 只读的既有 Claims；模型只能从中选择展示顺序。 */
  readonly claims: readonly Claim[];
  /** 只读的既有 Evidence；模型不能创造、改写或直接提供 citation identity。 */
  readonly evidenceRecords: readonly EvidenceRecord[];
}

/** 一次 Model Port generation 的非持久化调用控制。 */
export interface ModelCallOptions {
  /** 调用方用于取消仍在流式传输、尚未形成 completed result 的信号。 */
  readonly abortSignal?: AbortSignal | undefined;
}

/** 隔离模型 SDK 与运行时控制流的最小端口。 */
export interface ModelPort {
  /** live adapter 声明的非秘密实验身份；legacy/test adapter 可以省略。 */
  readonly experimentIdentity?: ExperimentIdentity | undefined;
  /** 为一个新 Run 返回完整计划；部分流式 delta 不进入该契约。 */
  proposePlan(
    request: PlanRequest,
    options?: ModelCallOptions,
  ): Promise<ResearchPlan>;
  /** 为已通过 Evidence Gate 前置条件的 Run 选择既有 Claims 并提供 Markdown 文案。 */
  proposeLearningArtifact(
    request: LearningArtifactProposalRequest,
    options?: ModelCallOptions,
  ): Promise<LearningArtifactProposal>;
  /** 从 Harness 构建的 Model View 完成一个 Research Loop generation。 */
  generateResearchTurn?(
    view: ModelView,
    options?: ModelCallOptions,
  ): Promise<Omit<ModelTurn, "turnId" | "completedAt">>;
}

/** Harness 调度 `search_sources` 时依赖的可注入本地 discovery 边界。 */
export interface SourceSearchPort {
  /** 在已批准 Source Scope 内返回原始顺序的有界匹配，不创建 Source Snapshot。 */
  search(
    scope: SourceScope,
    request: SourceSearchRequest,
  ): Promise<readonly SourceSearchMatch[]>;
}

/** `search_sources` Port 的 Harness-owned 有界请求。 */
export interface SourceSearchRequest {
  /** 非空 literal query；实现不得把它解释为 shell 参数。 */
  readonly query: string;
  /** 全部 roots 合计允许返回的最大命中数。 */
  readonly maxResults: number;
}
