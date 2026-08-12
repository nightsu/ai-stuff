import type {
  BudgetExhaustedRunState,
  EvidenceBackedRunStateData,
  RemainingRunBudget,
  ResearchToolObservation,
  RunBudget,
  SourceReadObservation,
} from "./types.js";

/** canonical usage facts 无法形成可重放预算余额时抛出的领域错误。 */
export class RunBudgetCalculationError extends Error {}

/** 计算五维剩余预算所需的最小 canonical context。 */
export interface RemainingRunBudgetContext {
  /** 创建 Run 时冻结且已绑定计划审批的限制。 */
  readonly runBudget: RunBudget;
  /** 从 Run Journal 派生的 Evidence-backed usage facts。 */
  readonly state: EvidenceBackedRunStateData;
  /** 本次判断的 ISO 8601 UTC 时间。 */
  readonly evaluatedAt: string;
}

/** 按稳定 `toolCallId` 去重显式读取与 Research Loop observation 的逻辑调用数。 */
export function countLogicalToolCalls(
  sourceReadObservations: readonly SourceReadObservation[],
  researchToolObservations: readonly ResearchToolObservation[],
): number {
  return new Set([
    ...sourceReadObservations.map((observation) => observation.toolCallId),
    ...researchToolObservations.map((observation) => observation.toolCallId),
  ]).size;
}

/** 从 canonical facts 唯一计算 Model View、暂停事件和 replay 共用的预算余额。 */
export function calculateRemainingRunBudget(
  context: RemainingRunBudgetContext,
): RemainingRunBudget {
  const distinctSources = new Set(
    context.state.sourceReadObservations.flatMap((observation) =>
      observation.status === "succeeded"
        ? [observation.sourceSnapshot.snapshotId]
        : [],
    ),
  ).size;
  const elapsedMs =
    context.state.researchStartedAt === undefined
      ? 0
      : Date.parse(context.evaluatedAt) -
        Date.parse(context.state.researchStartedAt) -
        context.state.suspendedDurationMs;
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new RunBudgetCalculationError("Research Loop wall time 无效");
  }
  return {
    modelTurns: Math.max(
      0,
      context.runBudget.maxModelTurns -
        1 -
        context.state.modelTurns.length -
        context.state.evidenceGateRepairs.filter(
          (repair) => repair.artifactProposalTurnConsumed,
        ).length,
    ),
    toolCalls: Math.max(
      0,
      context.runBudget.maxToolCalls - countLogicalToolCalls(
        context.state.sourceReadObservations,
        context.state.researchToolObservations,
      ),
    ),
    distinctSources: Math.max(
      0,
      context.runBudget.maxDistinctSources - distinctSources,
    ),
    sourceBytes: Math.max(
      0,
      context.runBudget.maxSourceBytes - context.state.sourceBytesRead,
    ),
    wallTimeMs: Math.max(0, context.runBudget.maxWallTimeMs - elapsedMs),
  };
}

/** 按稳定优先级选择当前阶段第一个阻止继续推进的硬预算维度。 */
export function firstExhaustedRunBudgetDimension(
  remaining: RemainingRunBudget,
  phase: "model" | "tool",
): BudgetExhaustedRunState["exhaustedDimension"] | undefined {
  if (remaining.wallTimeMs === 0) return "wall_time";
  if (phase === "model" && remaining.modelTurns === 0) return "model_turns";
  if (remaining.toolCalls === 0) return "tool_calls";
  if (remaining.distinctSources === 0) return "distinct_sources";
  if (remaining.sourceBytes === 0) return "source_bytes";
  return undefined;
}
