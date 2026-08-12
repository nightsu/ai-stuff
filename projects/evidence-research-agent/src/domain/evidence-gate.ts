import type {
  Claim,
  EvidenceRecord,
  LearningArtifactProposal,
  ResearchToolObservation,
  RunBudget,
  SourceReadObservation,
} from "./types.js";

/** Evidence Gate 无法从已登记来源事实构造可发布 Markdown 时抛出的领域错误。 */
export class EvidenceGateError extends Error {}

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

/** Gate 接受后可被 renderer 使用、且已经按模型选择顺序冻结的事实集合。 */
export interface EvidenceGateResult {
  /** 经过存在性与去重验证后、按提案顺序保留的完整 Claims。 */
  readonly claims: readonly Claim[];
  /** 被所选 Claims 引用且按首次出现顺序去重的完整 Evidence Records。 */
  readonly evidenceRecords: readonly EvidenceRecord[];
}

/** Evidence Gate 在渲染 draft 时重算、不可由模型覆盖的 Run 预算事实。 */
export interface EvidenceGateBudgetContext {
  /** 当前 one-shot slice 已由 Journal 可证明消耗的 ModelPort turn 数。 */
  readonly modelTurnsUsed: number;
  /** Journal 可证明已完成的逻辑 Research Tool call 数。 */
  readonly toolCallsUsed: number;
  /** Journal 中已经发生的安全来源读取 observation；每条都计入 tool-call 限额。 */
  readonly sourceReadObservations: readonly SourceReadObservation[];
  /** 创建 Run 时冻结并经计划审批绑定的多维预算。 */
  readonly runBudget: RunBudget;
  /** 计费活动开始时间；Research Loop 使用首个 Model Turn，显式旧路径使用 Run 创建时间。 */
  readonly wallTimeStartedAt: string;
  /** 计费活动结束时间；已完成 Research Loop 使用 completion 时间，活动路径使用 Gate 时间。 */
  readonly wallTimeEndedAt: string;
}

/**
 * 只允许结构化 Evidence 驱动 Learning Artifact：模型可以选择已经存在的 Claim，
 * 但不能传入、创造或重写 citation identity。renderer 只接收本函数返回的对象。
 */
export function evaluateEvidenceGate(
  proposal: LearningArtifactProposal,
  claims: readonly Claim[],
  evidenceRecords: readonly EvidenceRecord[],
): EvidenceGateResult {
  if (
    proposal.claimIds.length === 0 ||
    new Set(proposal.claimIds).size !== proposal.claimIds.length
  ) {
    throw new EvidenceGateError("Learning Artifact 提案必须选择唯一的既有 Claim");
  }

  const selectedClaims = proposal.claimIds.map((claimId) => {
    const claim = claims.find((candidate) => candidate.claimId === claimId);
    if (
      claim?.kind !== "source_fact" ||
      claim.evidenceIds.length === 0
    ) {
      throw new EvidenceGateError("Learning Artifact Claim 缺少可验证 Evidence");
    }
    return claim;
  });

  const selectedEvidenceIds = selectedClaims.flatMap(
    (claim) => claim.evidenceIds,
  );
  const uniqueEvidenceIds = [...new Set(selectedEvidenceIds)];
  const selectedEvidenceRecords = uniqueEvidenceIds.map((evidenceId) => {
    const evidence = evidenceRecords.find(
      (candidate) => candidate.evidenceId === evidenceId,
    );
    if (evidence?.kind !== "source_fact") {
      throw new EvidenceGateError("Learning Artifact citation 必须是 source_fact Evidence");
    }
    return evidence;
  });

  return {
    claims: selectedClaims,
    evidenceRecords: selectedEvidenceRecords,
  };
}

/**
 * Publication 不能绕过已经冻结的 Run Budget。source bytes 会在读取 reducer 中先
 * 限制，这里仍从 Journal 重新求和；tool/source/wall-time 同样只信任 durable facts。
 */
export function assertEvidenceGateBudget(
  context: EvidenceGateBudgetContext,
): void {
  const successfulObservations = context.sourceReadObservations.filter(
    (observation) => observation.status === "succeeded",
  );
  const sourceBytesRead = successfulObservations.reduce(
    (total, observation) => total + observation.byteLength,
    0,
  );
  const distinctSources = new Set(
    successfulObservations.map(
      (observation) => observation.sourceSnapshot.snapshotId,
    ),
  ).size;
  const elapsedMs =
    Date.parse(context.wallTimeEndedAt) - Date.parse(context.wallTimeStartedAt);
  if (
    context.modelTurnsUsed > context.runBudget.maxModelTurns ||
    context.toolCallsUsed > context.runBudget.maxToolCalls ||
    distinctSources > context.runBudget.maxDistinctSources ||
    sourceBytesRead > context.runBudget.maxSourceBytes ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > context.runBudget.maxWallTimeMs
  ) {
    throw new EvidenceGateError("Learning Artifact 超出已批准 Run Budget");
  }
}
