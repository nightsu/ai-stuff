import type {
  Claim,
  EvidenceRecord,
  LearningArtifactProposal,
} from "./types.js";

/** Evidence Gate 无法从已登记来源事实构造可发布 Markdown 时抛出的领域错误。 */
export class EvidenceGateError extends Error {}

/** Gate 接受后可被 renderer 使用、且已经按模型选择顺序冻结的事实集合。 */
export interface EvidenceGateResult {
  /** 经过存在性与去重验证后、按提案顺序保留的完整 Claims。 */
  readonly claims: readonly Claim[];
  /** 被所选 Claims 引用且按首次出现顺序去重的完整 Evidence Records。 */
  readonly evidenceRecords: readonly EvidenceRecord[];
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
    if (claim === undefined || claim.evidenceIds.length === 0) {
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
