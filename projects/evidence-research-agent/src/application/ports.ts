import type {
  Claim,
  EvidenceRecord,
  LearningArtifactProposal,
  ModelTurn,
  ModelView,
  ResearchPlan,
  SourceSearchMatch,
  SourceScope,
} from "../domain/types.js";

/** 为运行时提供可注入时间的边界。 */
export interface Clock {
  /** 返回当前时间的 ISO 8601 UTC 字符串。 */
  now(): string;
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

/** 隔离模型 SDK 与运行时控制流的最小端口。 */
export interface ModelPort {
  /** 为一个新 Run 返回完整计划；部分流式 delta 不进入该契约。 */
  proposePlan(request: PlanRequest): Promise<ResearchPlan>;
  /** 为已通过 Evidence Gate 前置条件的 Run 选择既有 Claims 并提供 Markdown 文案。 */
  proposeLearningArtifact(
    request: LearningArtifactProposalRequest,
  ): Promise<LearningArtifactProposal>;
  /** 从 Harness 构建的 Model View 完成一个 Research Loop generation。 */
  generateResearchTurn?(view: ModelView): Promise<Omit<ModelTurn, "turnId" | "completedAt">>;
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
