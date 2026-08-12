import { hashCanonicalJson } from "./integrity.js";
import { assertNoPreRenderedCitationToken } from "./citation-safety.js";
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

/** 比较 receipt/state 中的 publication binding，不让任一冗余字段获得独立授权力。 */
export function publicationBindingsEqual(
  expected: PublicationApprovalBinding,
  actual: PublicationApprovalBinding,
): boolean {
  return (
    actual.draftHash === expected.draftHash &&
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
): string {
  // title/summary/Claim 都是非结构化文案；只允许下面的 renderer 使用 Gate 事实
  // 拼出 citation，不能让模型或调用方夹带一个看似可信却无 Evidence 的可见 token。
  assertNoPreRenderedCitationToken([
    proposal.title,
    proposal.summary,
    ...gate.claims.map((claim) => claim.text),
  ]);
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
  const toolLines = gate.evidenceRecords.map(
    (evidence) => `- read_source: ${evidence.toolCallId}`,
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
    "## Evidence Index",
    "",
    ...evidenceLines,
    "",
    "## Tool usage",
    "",
    ...toolLines,
    "",
  ].join("\n");
}
