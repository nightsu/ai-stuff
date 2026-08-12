import type { RunTrace } from "../domain/types.js";

/** Run Trace 支持的稳定文本编码。 */
export type RunTraceFormat = "human" | "json";

export function formatRunTrace(
  trace: RunTrace,
  format: RunTraceFormat,
): string {
  if (format === "json") {
    return JSON.stringify(trace, null, 2);
  }

  return [
    `Run ${trace.runId}`,
    ...(trace.experimentIdentity === undefined
      ? []
      : [
          `Experiment: provider=${trace.experimentIdentity.provider} model=${trace.experimentIdentity.model} adapter=${trace.experimentIdentity.adapterVersion} prompt=${trace.experimentIdentity.promptVersion} tools=${trace.experimentIdentity.toolSchemaVersion}`,
        ]),
    `Current state: ${trace.finalState}`,
    ...trace.events.map((event) => {
      const lineage = [
        event.toolCallId === undefined ? undefined : `tool=${event.toolCallId}`,
        event.observationId === undefined
          ? undefined
          : `observation=${event.observationId}`,
        event.observationStatus === undefined
          ? undefined
          : `status=${event.observationStatus}`,
        event.sourceSnapshotId === undefined
          ? undefined
          : `snapshot=${event.sourceSnapshotId}`,
        event.evidenceId === undefined
          ? undefined
          : `evidence=${event.evidenceId}`,
        event.claimId === undefined ? undefined : `claim=${event.claimId}`,
        event.claimKind === undefined
          ? undefined
          : `claim-kind=${event.claimKind}`,
        event.evidenceIds === undefined
          ? undefined
          : `evidence-ids=${event.evidenceIds.join(",")}`,
        event.evidenceGateRepairCode === undefined
          ? undefined
          : `evidence-gate-repair=${event.evidenceGateRepairCode}`,
        event.draftArtifactId === undefined
          ? undefined
          : `draft=${event.draftArtifactId}`,
        event.publicationApprovalId === undefined
          ? undefined
          : `publication-approval=${event.publicationApprovalId}`,
        event.learningArtifactSha256 === undefined
          ? undefined
          : `published-sha256=${event.learningArtifactSha256}`,
        event.retrySequenceId === undefined
          ? undefined
          : `retry-sequence=${event.retrySequenceId}`,
        event.retrySequenceKind === undefined
          ? undefined
          : `retry-sequence-kind=${event.retrySequenceKind}`,
        event.attemptNumber === undefined
          ? undefined
          : `attempt=${event.attemptNumber}`,
        event.attemptOutcome === undefined
          ? undefined
          : `outcome=${event.attemptOutcome}`,
        event.attemptDurationMs === undefined
          ? undefined
          : `duration-ms=${event.attemptDurationMs}`,
        event.retryPolicyVersion === undefined
          ? undefined
          : `retry-policy=${event.retryPolicyVersion}`,
        event.failureCategory === undefined || event.failureCode === undefined
          ? undefined
          : `failure=${event.failureCategory}/${event.failureCode}`,
        event.retryDelayMs === undefined
          ? undefined
          : `retry-delay-ms=${event.retryDelayMs}`,
      ].filter((value): value is string => value !== undefined);
      return `#${event.sequence} ${event.type} → ${event.stateAfter} (${event.occurredAt})${lineage.length === 0 ? "" : ` [${lineage.join(" ")}]`}`;
    }),
  ].join("\n");
}
