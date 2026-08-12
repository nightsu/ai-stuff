import type {
  Claim,
  EvidenceGateRepair,
  EvidenceGateRepairCode,
  EvidenceRecord,
  LearningArtifactProposal,
  RunBudget,
  SourceScope,
  SourceReadObservation,
  SourceSnapshotReference,
  SucceededSourceReadObservation,
} from "./types.js";
import { hashUtf8Text } from "./integrity.js";
import {
  sourcePathPolicyDenial,
  sourceRequestDenial,
} from "./source-policy.js";

/** Evidence Gate 无法构造 draft 时携带稳定 repair code 的领域错误。 */
export class EvidenceGateError extends Error {
  /** 可被 Journal 持久化、不会泄漏 payload 的稳定问题代码。 */
  public readonly code: EvidenceGateRepairCode;

  public constructor(code: EvidenceGateRepairCode) {
    super(evidenceGateRepairGuidance(code).summary);
    this.name = "EvidenceGateError";
    this.code = code;
  }
}

/** 从稳定 code 构造 reducer 可重算的 durable repair fact。 */
export function createEvidenceGateRepair(input: {
  /** 承载 repair 的 Journal event identity。 */
  readonly eventId: string;
  /** Evidence Gate 分配的稳定问题代码。 */
  readonly code: EvidenceGateRepairCode;
  /** Gate 失败前是否已获得完整 Artifact proposal 模型输出。 */
  readonly artifactProposalTurnConsumed: boolean;
  /** repair event 的精确业务时间。 */
  readonly requestedAt: string;
}): EvidenceGateRepair {
  return {
    repairId: `repair-${input.eventId}`,
    code: input.code,
    ...evidenceGateRepairGuidance(input.code),
    artifactProposalTurnConsumed: input.artifactProposalTurnConsumed,
    requestedAt: input.requestedAt,
  };
}

/** 把稳定 code 映射为确定性、可操作且可由 reducer 重算的中文反馈。 */
export function evidenceGateRepairGuidance(
  code: EvidenceGateRepairCode,
): Pick<EvidenceGateRepair, "summary" | "recommendedAction"> {
  switch (code) {
    case "invalid_claim_selection":
      return {
        summary: "Learning Artifact 必须选择至少一个且不重复的 Claim",
        recommendedAction: "重新提交非空且去重的 durable Claim identities",
      };
    case "unknown_claim_id":
      return {
        summary: "Learning Artifact 选择了当前 Run 不存在的 Claim",
        recommendedAction: "重新选择当前 Run 已登记的 Claim identity",
      };
    case "claim_evidence_required":
      return {
        summary: "Claim 分类要求可验证 Evidence",
        recommendedAction: "为 source_fact 或 inference 登记并引用有效 Evidence",
      };
    case "unknown_evidence_id":
      return {
        summary: "Claim 引用了当前 Run 不存在的 Evidence",
        recommendedAction: "改为引用当前 Run 已登记的 Evidence identity",
      };
    case "invalid_evidence_kind":
      return {
        summary: "Claim citation 未引用 source_fact Evidence Record",
        recommendedAction: "重新登记来自成功 source read 的 Evidence",
      };
    case "lineage_mismatch":
      return {
        summary: "Evidence 未精确绑定 completed approved source read",
        recommendedAction: "从成功 read_source observation 重新登记 Evidence",
      };
    case "snapshot_integrity_failure":
      return {
        summary: "Source Snapshot content identity 无法验证",
        recommendedAction: "重新读取批准来源以创建有效 immutable Snapshot",
      };
    case "snapshot_range_invalid":
      return {
        summary: "Evidence 范围超出 immutable Source Snapshot",
        recommendedAction: "按 Snapshot 的有效 1-based 行范围重新读取并登记 Evidence",
      };
    case "excerpt_mismatch":
      return {
        summary: "Evidence excerpt 与 immutable Source Snapshot 不一致",
        recommendedAction: "从 Snapshot 对应的成功读取重新登记 Evidence",
      };
    case "approval_invalid":
      return {
        summary: "计划审批不再精确授权当前研究边界",
        recommendedAction:
          "创建新的 Research Run，并批准新的 Source Scope 与计划版本",
      };
    case "proposal_invalid":
      return {
        summary: "Artifact proposal 不满足结构化输出契约",
        recommendedAction:
          "重新生成包含 title、summary 与 durable Claim identities 的提案",
      };
    case "budget_violation":
      return {
        summary: "Learning Artifact 超出已批准 Run Budget",
        recommendedAction: "请求用户批准更高预算版本或缩小研究工作",
      };
  }
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

/** Evidence Gate 校验 immutable Snapshot 所需的 canonical Run facts 与读取端口。 */
export interface EvidenceGateLineageContext {
  /** 当前计划审批所绑定、且 reducer 已验证的精确 Source Scope。 */
  readonly sourceScope: SourceScope;
  /** 当前 Run 中所有 completed source read observations。 */
  readonly sourceReadObservations: readonly SourceReadObservation[];
  /** 只按 content identity 返回完整私有 Source Snapshot bytes 的读取边界。 */
  readonly readSourceSnapshot: (
    reference: SourceSnapshotReference,
  ) => Promise<Uint8Array>;
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
    throw new EvidenceGateError("invalid_claim_selection");
  }

  const selectedClaims = proposal.claimIds.map((claimId) => {
    const claim = claims.find((candidate) => candidate.claimId === claimId);
    if (claim === undefined) throw new EvidenceGateError("unknown_claim_id");
    if (
      claim.kind !== "design_recommendation" &&
      claim.evidenceIds.length === 0
    ) throw new EvidenceGateError("claim_evidence_required");
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
    if (evidence === undefined) throw new EvidenceGateError("unknown_evidence_id");
    if (evidence.kind !== "source_fact") {
      throw new EvidenceGateError("invalid_evidence_kind");
    }
    return evidence;
  });

  return {
    claims: selectedClaims,
    evidenceRecords: selectedEvidenceRecords,
  };
}

/**
 * 对 renderer 将使用的每条 Evidence 执行完整 lineage 验证。live source 不参与：
 * 范围和摘录只从 immutable Snapshot bytes 重算，避免工作区后续变化追溯改写事实。
 */
export async function assertEvidenceGateLineage(
  gate: EvidenceGateResult,
  context: EvidenceGateLineageContext,
): Promise<void> {
  const snapshots = new Map<string, Uint8Array>();
  for (const evidence of gate.evidenceRecords) {
    const observation = context.sourceReadObservations.find(
      (candidate): candidate is SucceededSourceReadObservation =>
        candidate.status === "succeeded" &&
        candidate.observationId === evidence.observationId,
    );
    if (
      observation === undefined ||
      observation.toolName !== "read_source" ||
      observation.toolCallId !== evidence.toolCallId ||
      observation.sourceSnapshot.snapshotId !== evidence.sourceSnapshotId ||
      observation.rootIndex !== evidence.rootIndex ||
      observation.relativePath !== evidence.relativePath ||
      observation.startLine !== evidence.startLine ||
      observation.endLine !== evidence.endLine ||
      observation.excerptHash !== evidence.excerptHash ||
      sourceRequestDenial(
        {
          rootIndex: evidence.rootIndex,
          relativePath: evidence.relativePath,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
        },
        context.sourceScope.roots.length,
        Number.MAX_SAFE_INTEGER,
      ) !== undefined ||
      sourcePathPolicyDenial(
        evidence.relativePath,
        context.sourceScope,
      ) !== undefined
    ) {
      throw new EvidenceGateError("lineage_mismatch");
    }

    let bytes = snapshots.get(observation.sourceSnapshot.snapshotId);
    if (bytes === undefined) {
      try {
        bytes = await context.readSourceSnapshot(observation.sourceSnapshot);
      } catch {
        throw new EvidenceGateError("snapshot_integrity_failure");
      }
      snapshots.set(observation.sourceSnapshot.snapshotId, bytes);
    }
    const snapshotLines = decodeSnapshotLines(bytes);
    if (
      observation.totalLines !== snapshotLines.length ||
      evidence.endLine > snapshotLines.length
    ) {
      throw new EvidenceGateError("snapshot_range_invalid");
    }
    const excerpt = snapshotLines
      .slice(evidence.startLine - 1, evidence.endLine)
      .join("\n");
    if (
      excerpt !== observation.excerpt ||
      hashUtf8Text(excerpt) !== evidence.excerptHash
    ) {
      throw new EvidenceGateError("excerpt_mismatch");
    }
  }
}

function decodeSnapshotLines(bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EvidenceGateError("snapshot_integrity_failure");
  }
  if (text.includes("\0")) {
    throw new EvidenceGateError("snapshot_integrity_failure");
  }
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r\n$|[\n\r]$/.test(text)) lines.pop();
  return lines;
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
    throw new EvidenceGateError("budget_violation");
  }
}
