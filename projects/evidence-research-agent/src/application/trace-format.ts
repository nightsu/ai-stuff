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
    ...trace.events.map(
      (event) =>
        `#${event.sequence} ${event.type} → ${event.stateAfter} (${event.occurredAt})`,
    ),
  ].join("\n");
}
