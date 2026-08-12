import { hashCanonicalJson } from "./integrity.js";
import { assertNoPreRenderedCitationToken } from "./citation-safety.js";
import { publicationEvaluationHash } from "./evaluator-review.js";
import type {
  LearningArtifactProposal,
  LearningArtifactToolUsage,
  PublicationEvaluation,
  PublicationApprovalBinding,
  PublicationApprovalSummary,
  PublicationTarget,
  ResearchToolObservation,
  SourceReadObservation,
} from "./types.js";
import type { EvidenceGateResult } from "./evidence-gate.js";

/** 计算 exact Markdown draft 与 canonical publication target 的用户审批边界。 */
export function createPublicationApprovalBinding(input: {
  /** 私有 Artifact Store 中已经写入的精确 Markdown draft SHA-256。 */
  readonly draftHash: string;
  /** 成功 review 或用户 explicit skip 的 exact publication evaluation。 */
  readonly evaluation: PublicationEvaluation;
  /** 已通过 parent realpath/device/inode 捕获的用户可见发布目标。 */
  readonly publicationTarget: PublicationTarget;
}): PublicationApprovalBinding {
  if (!/^[a-f0-9]{64}$/.test(input.draftHash)) {
    throw new TypeError("publication draftHash 必须是 64 位小写十六进制 SHA-256 摘要");
  }
  const components = {
    draftHash: input.draftHash,
    evaluationKind: input.evaluation.kind,
    evaluationHash: publicationEvaluationHash(input.evaluation),
    outputRootCanonicalPath: input.publicationTarget.outputRootCanonicalPath,
    outputRootDevice: input.publicationTarget.outputRootDevice,
    outputRootInode: input.publicationTarget.outputRootInode,
    targetCanonicalPath: input.publicationTarget.targetCanonicalPath,
    parentDevice: input.publicationTarget.parentDevice,
    parentInode: input.publicationTarget.parentInode,
  };
  return {
    ...components,
    bindingHash: hashCanonicalJson(components),
  };
}

/** 从 Gate 与 exact evaluation 派生用户审批面，warning 不获得授权能力。 */
export function createPublicationApprovalSummary(
  gate: EvidenceGateResult,
  evaluation: PublicationEvaluation,
): PublicationApprovalSummary {
  return {
    hardGate: {
      status: "passed",
      claimCount: gate.claims.length,
      evidenceCount: gate.evidenceRecords.length,
    },
    advisoryWarnings: evaluation.kind === "reviewed"
      ? evaluation.review.verdicts.flatMap((verdict) =>
          verdict.verdict === "supported"
            ? []
            : [{
                kind: "claim_verdict" as const,
                claimId: verdict.claimId,
                verdict: verdict.verdict,
              }]
        )
      : [{
          kind: "evaluator_skipped",
          skipId: evaluation.identity.skipId,
        }],
  };
}

/** 判定 Conclusion 是否为一个单行句子，拒绝把段落伪装成一句话摘要。 */
export function isSingleSentenceConclusion(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || /[\r\n]/u.test(trimmed)) return false;
  const withoutFinalPunctuation = trimmed.replace(/[。！？.!?]$/u, "");
  return (
    !/[。！？!?]/u.test(withoutFinalPunctuation) &&
    !/\.\s+\S/u.test(withoutFinalPunctuation)
  );
}

/** 从 durable observations 按 tool-call identity 统计实际五工具使用量。 */
export function calculateLearningArtifactToolUsage(input: {
  /** 所有显式/Research Loop `read_source` durable observations。 */
  readonly sourceReadObservations: readonly SourceReadObservation[];
  /** Research Loop 五工具的模型可见 durable observations。 */
  readonly researchToolObservations: readonly ResearchToolObservation[];
}): LearningArtifactToolUsage {
  const count = (toolName: ResearchToolObservation["toolName"]): number =>
    new Set(
      input.researchToolObservations
        .filter((observation) => observation.toolName === toolName)
        .map((observation) => observation.toolCallId),
    ).size;
  return {
    searchSources: count("search_sources"),
    readSource: new Set(
      input.sourceReadObservations.map((observation) => observation.toolCallId),
    ).size,
    recordEvidence: count("record_evidence"),
    proposeClaim: count("propose_claim"),
    completeResearch: count("complete_research"),
  };
}

/** 比较 receipt/state 中的 publication binding，不让任一冗余字段获得独立授权力。 */
export function publicationBindingsEqual(
  expected: PublicationApprovalBinding,
  actual: PublicationApprovalBinding,
): boolean {
  return (
    actual.draftHash === expected.draftHash &&
    actual.evaluationKind === expected.evaluationKind &&
    actual.evaluationHash === expected.evaluationHash &&
    actual.outputRootCanonicalPath === expected.outputRootCanonicalPath &&
    actual.outputRootDevice === expected.outputRootDevice &&
    actual.outputRootInode === expected.outputRootInode &&
    actual.targetCanonicalPath === expected.targetCanonicalPath &&
    actual.parentDevice === expected.parentDevice &&
    actual.parentInode === expected.parentInode &&
    actual.bindingHash === expected.bindingHash
  );
}

/**
 * 在 Evidence Gate 已选择的 Claim 上生成唯一 Markdown 形状。citation token 只在
 * 这里从结构化 Evidence identity 生成，因此模型既不能自造 ID，也不能改变引用归属。
 */
export function renderLearningArtifact(
  proposal: LearningArtifactProposal,
  gate: EvidenceGateResult,
  evaluation: PublicationEvaluation,
  context: LearningArtifactRenderContext,
): string {
  // title/summary/Claim 都是非结构化文案；只允许下面的 renderer 使用 Gate 事实
  // 拼出 citation，不能让模型或调用方夹带一个看似可信却无 Evidence 的可见 token。
  assertNoPreRenderedCitationToken([
    proposal.title,
    proposal.summary,
    ...gate.claims.map((claim) => claim.text),
  ]);
  const verdictByClaimId = new Map(
    evaluation.kind === "reviewed"
      ? evaluation.review.verdicts.map((verdict) => [
          verdict.claimId,
          verdict.verdict,
        ])
      : [],
  );
  const claimLines = gate.claims.map((claim) => {
    const citations = claim.evidenceIds
      .map((evidenceId) => `【Evidence: ${evidenceId}】`)
      .join(" ");
    const citationSuffix = citations === "" ? "" : ` ${citations}`;
    const verdict = evaluation.kind === "reviewed"
      ? verdictByClaimId.get(claim.claimId)
      : "skipped";
    return `- ${claim.claimId} [${claim.kind}] (Evaluator: ${verdict}): ${claim.text}${citationSuffix}`;
  });
  const evidenceLines = gate.evidenceRecords.map(
    (evidence) =>
      `- ${evidence.evidenceId}: ${evidence.relativePath} lines ${evidence.startLine}-${evidence.endLine}; ${evidence.sourceSnapshotId}; read_source ${evidence.toolCallId}`,
  );
  const toolLines = [
    `- search_sources: ${context.toolUsage.searchSources}`,
    `- read_source: ${context.toolUsage.readSource}`,
    `- record_evidence: ${context.toolUsage.recordEvidence}`,
    `- propose_claim: ${context.toolUsage.proposeClaim}`,
    `- complete_research: ${context.toolUsage.completeResearch}`,
  ];
  const uncertaintyLines = evaluation.kind === "reviewed"
    ? evaluation.review.verdicts
      .filter((verdict) => verdict.verdict !== "supported")
      .map((verdict) => `- ${verdict.claimId}: ${verdict.verdict}`)
    : ["- Evaluator Review was explicitly skipped by the user."];
  if (context.unresolvedQuestions.length > 0) {
    uncertaintyLines.push(
      ...context.unresolvedQuestions.map((question) => `- ${question}`),
    );
  }
  if (uncertaintyLines.length === 0) uncertaintyLines.push("- None recorded.");

  return [
    `# ${proposal.title}`,
    "",
    "## Conclusion",
    "",
    proposal.summary,
    "",
    "## Scope",
    "",
    `- Question: ${context.question}`,
    `- Approved local evidence records: ${gate.evidenceRecords.length}`,
    "",
    "## Claims",
    "",
    ...claimLines,
    "",
    "## Evidence Index",
    "",
    ...evidenceLines,
    "",
    "## Uncertainty",
    "",
    ...uncertaintyLines,
    "",
    "## Tool usage",
    "",
    ...toolLines,
    "",
  ].join("\n");
}

/** 确定性 renderer 从 Run facts 接收的非模型报告上下文。 */
export interface LearningArtifactRenderContext {
  /** Research Run 最初提交的技术问题。 */
  readonly question: string;
  /** Research Loop completion 声明的 unresolved questions；legacy 路径为空。 */
  readonly unresolvedQuestions: readonly string[];
  /** 从整个 durable Run 而非最终 Evidence selection 派生的实际工具统计。 */
  readonly toolUsage: LearningArtifactToolUsage;
}
