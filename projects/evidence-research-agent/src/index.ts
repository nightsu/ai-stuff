export { ScriptedModel, ScriptedModelExhaustedError } from "./adapters/scripted-model.js";
export { ResearchAgentRuntime } from "./application/research-agent-runtime.js";
export { formatRunTrace } from "./application/trace-format.js";
export { runCli } from "./cli.js";
export type { Clock, IdGenerator, ModelPort, PlanRequest } from "./application/ports.js";
export type {
  CreateRunCommand,
  InspectRunCommand,
  OpenRuntimeOptions,
  RebuildRunProjectionCommand,
  TraceRunCommand,
} from "./application/research-agent-runtime.js";
export type {
  ArtifactReference,
  ResearchPlan,
  ResearchRunEvent,
  ResearchRunState,
  RunProjection,
  RunTrace,
  RunTraceEvent,
  SourceScope,
} from "./domain/types.js";
