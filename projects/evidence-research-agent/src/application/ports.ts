import type { ResearchPlan, SourceScope } from "../domain/types.js";

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

/** 隔离模型 SDK 与运行时控制流的最小端口。 */
export interface ModelPort {
  /** 为一个新 Run 返回完整计划；部分流式 delta 不进入该契约。 */
  proposePlan(request: PlanRequest): Promise<ResearchPlan>;
}
