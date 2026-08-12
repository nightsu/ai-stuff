import { hashCanonicalJson } from "./integrity.js";
import type {
  LearningArtifactProposal,
  PublicationApprovalBinding,
  PublicationTarget,
} from "./types.js";
import type { EvidenceGateResult } from "./evidence-gate.js";

/** 计算 exact Markdown draft 与 canonical publication target 的用户审批边界。 */
export function createPublicationApprovalBinding(input: {
  /** 私有 Artifact Store 中已经写入的精确 Markdown draft SHA-256。 */
  readonly draftHash: string;
  /** 已通过 parent realpath/device/inode 捕获的用户可见发布目标。 */
  readonly publicationTarget: PublicationTarget;
}): PublicationApprovalBinding {
  if (!/^[a-f0-9]{64}$/.test(input.draftHash)) {
    throw new TypeError("publication draftHash 必须是 64 位小写十六进制 SHA-256 摘要");
  }
  const components = {
    draftHash: input.draftHash,
    targetCanonicalPath: input.publicationTarget.targetCanonicalPath,
    parentDevice: input.publicationTarget.parentDevice,
    parentInode: input.publicationTarget.parentInode,
  };
  return {
    ...components,
    bindingHash: hashCanonicalJson(components),
  };
}

/** 比较 receipt/state 中的 publication binding，不让任一冗余字段获得独立授权力。 */
export function publicationBindingsEqual(
  expected: PublicationApprovalBinding,
  actual: PublicationApprovalBinding,
): boolean {
  return (
    actual.draftHash === expected.draftHash &&
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
): string {
  const claimLines = gate.claims.map((claim) => {
    const citations = claim.evidenceIds
      .map((evidenceId) => `【Evidence: ${evidenceId}】`)
      .join(" ");
    return `- ${claim.text} ${citations}`;
  });
  const evidenceLines = gate.evidenceRecords.map(
    (evidence) =>
      `- ${evidence.evidenceId}: ${evidence.sourceSnapshotId} lines ${evidence.startLine}-${evidence.endLine}`,
  );

  return [
    `# ${proposal.title}`,
    "",
    proposal.summary,
    "",
    "## Claims",
    "",
    ...claimLines,
    "",
    "## Evidence identity",
    "",
    ...evidenceLines,
    "",
  ].join("\n");
}
