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
    `Current state: ${trace.finalState}`,
    ...trace.events.map((event) => {
      const lineage = [
        event.toolCallId === undefined ? undefined : `tool=${event.toolCallId}`,
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
        event.draftArtifactId === undefined
          ? undefined
          : `draft=${event.draftArtifactId}`,
        event.publicationApprovalId === undefined
          ? undefined
          : `publication-approval=${event.publicationApprovalId}`,
        event.learningArtifactSha256 === undefined
          ? undefined
          : `published-sha256=${event.learningArtifactSha256}`,
      ].filter((value): value is string => value !== undefined);
      return `#${event.sequence} ${event.type} → ${event.stateAfter} (${event.occurredAt})${lineage.length === 0 ? "" : ` [${lineage.join(" ")}]`}`;
    }),
  ].join("\n");
}
