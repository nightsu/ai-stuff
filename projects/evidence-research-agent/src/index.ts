export { ScriptedModel, ScriptedModelExhaustedError } from "./adapters/scripted-model.js";
export {
  IllegalPlanApprovalStateError,
  InvalidSourceScopeError,
  InvalidPlanApprovalCommandError,
  PlanApprovalConflictError,
  ResearchAgentRuntime,
  StalePlanApprovalError,
} from "./application/research-agent-runtime.js";
export { formatRunTrace } from "./application/trace-format.js";
export { runCli } from "./cli.js";
export {
  createPlanApprovalBinding,
  hashCanonicalJson,
} from "./domain/integrity.js";
export type { Clock, IdGenerator, ModelPort, PlanRequest } from "./application/ports.js";
export type {
  ApprovePlanCommand,
  CreateRunCommand,
  InspectRunCommand,
  OpenRuntimeOptions,
  RebuildRunProjectionCommand,
  TraceRunCommand,
} from "./application/research-agent-runtime.js";
export type {
  ArtifactReference,
  PlanApprovalBinding,
  PlanApprovalReceipt,
  ResearchPlan,
  ResearchRunEvent,
  ResearchRunState,
  ResearchingRunState,
  PersistedSourceSnapshot,
  RunBudget,
  RunProjection,
  RunTrace,
  RunTraceEvent,
  RequestedSourceScope,
  SourceRootIdentity,
  SourceSnapshotReference,
  SourceScope,
} from "./domain/types.js";
