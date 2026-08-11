export { ScriptedModel, ScriptedModelExhaustedError } from "./adapters/scripted-model.js";
export {
  IllegalPlanApprovalStateError,
  IllegalEvidenceStateError,
  IllegalSourceReadStateError,
  InvalidClaimCommandError,
  InvalidEvidenceCommandError,
  InvalidSourceReadCommandError,
  InvalidSourceScopeError,
  InvalidPlanApprovalCommandError,
  PlanApprovalConflictError,
  ClaimEvidenceNotAvailableError,
  EvidenceObservationNotAvailableError,
  EvidencePersistenceError,
  EvidenceWriteConflictError,
  ResearchAgentRuntime,
  SourceReadConflictError,
  SourceReadPersistenceError,
  SourceReadRunNotFoundError,
  StalePlanApprovalError,
} from "./application/research-agent-runtime.js";
export { formatRunTrace } from "./application/trace-format.js";
export { runCli } from "./cli.js";
export { PrivateRuntimeHomeError } from "./infrastructure/private-runtime-home.js";
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
  ReadSourceCommand,
  RecordClaimCommand,
  RecordEvidenceCommand,
  RebuildRunProjectionCommand,
  TraceRunCommand,
} from "./application/research-agent-runtime.js";
export type {
  ArtifactReference,
  Claim,
  PlanApprovalBinding,
  PlanApprovalReceipt,
  ReadSourceRequest,
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
  SourceAccessDenialCode,
  SourceAccessFailureCode,
  SourceReadObservation,
  SucceededSourceReadObservation,
  DeniedSourceReadObservation,
  EvidenceRecord,
  FailedSourceReadObservation,
  SourceSnapshotReference,
  SourceScope,
} from "./domain/types.js";
