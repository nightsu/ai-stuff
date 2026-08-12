import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  artifactReferenceHasMatchingContentIdentity,
  sourceSnapshotHasMatchingContentIdentity,
} from "./integrity.js";
import { hasPreRenderedCitationToken } from "./citation-safety.js";
import { isSingleSentenceConclusion } from "./learning-artifact.js";
import type {
  Claim,
  EvidenceGateRepair,
  EvidenceRecord,
  ExperimentIdentity,
  EvaluatorIdentity,
  EvaluatorReview,
  EvaluatorReviewFailure,
  EvaluatorReviewRequest,
  PublicationEvaluation,
  LearningArtifactProposal,
  ModelTurn,
  RetryAttempt,
  PlanApprovalBinding,
  PlanApprovalReceipt,
  PublicationApprovalBinding,
  PublicationApprovalSummary,
  PublicationApprovalReceipt,
  ConflictingPublicationEffect,
  ExecutingPublicationEffect,
  PendingPublicationEffect,
  PublicationTarget,
  PublishedLearningArtifact,
  SucceededPublicationEffect,
  UnknownPublicationEffect,
  ReadSourceRequest,
  RetryPolicy,
  ResearchPlan,
  ResearchRunEvent,
  ResearchToolObservation,
  RequestedSourceScope,
  RunBudget,
  RunProjection,
  ResearchRunState,
  SourceReadObservation,
  SourceScope,
  SourceSnapshotReference,
} from "./types.js";

const sourceScopePolicyFields = {
  exclusions: z.array(z.string().min(1)),
  allowedExtensions: z
    .array(z.string().regex(/^\.[a-z0-9]+$/, "扩展名必须是含前导点的小写 ASCII"))
    .min(1),
  maxFileBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
};

export const requestedSourceScopeSchema = z
  .object({
    roots: z
      .array(z.string().min(1).refine(isAbsolute, "Source Scope root 必须是绝对路径"))
      .min(1),
    ...sourceScopePolicyFields,
  })
  .strict();

export const sourceScopeSchema = z
  .object({
    roots: z
      .array(
        z
          .object({
            canonicalPath: z
              .string()
              .min(1)
              .refine(isAbsolute, "canonical Source Root 必须是绝对路径"),
            device: z.string().regex(/^\d+$/),
            inode: z.string().regex(/^\d+$/),
          })
          .strict(),
      )
      .min(1),
    ...sourceScopePolicyFields,
  })
  .strict();

export const runBudgetSchema = z.object({
  version: z.string().trim().min(1),
  maxModelTurns: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxDistinctSources: z.number().int().positive(),
  maxSourceBytes: z.number().int().positive(),
  maxWallTimeMs: z.number().int().positive(),
});

export const retryPolicySchema = z.object({
  version: z.string().trim().min(1),
  modelMaxAttempts: z.number().int().positive(),
  toolMaxAttempts: z.number().int().positive(),
  baseDelayMs: z.number().int().nonnegative(),
  maxDelayMs: z.number().int().nonnegative(),
}).strict().refine(
  (policy) => policy.baseDelayMs <= policy.maxDelayMs,
  "retry base delay 不能大于上限",
);

export const researchPlanSchema = z.object({
  title: z.string().trim().min(1),
  objectives: z.array(z.string().trim().min(1)).min(1),
  steps: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        description: z.string().trim().min(1),
      }),
    )
    .min(1),
});

export const readSourceRequestSchema = z
  .object({
    rootIndex: z.number().finite(),
    relativePath: z.string(),
    startLine: z.number().finite(),
    endLine: z.number().finite(),
  })
  .strict()
  .transform((request): ReadSourceRequest => request);

const artifactReferenceSchema = z
  .object({
    artifactId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    relativePath: z.string().min(1),
  })
  .superRefine((reference, context) => {
    // 稳定内容寻址 identity 必须与同一引用中的摘要完全一致；分别满足格式
    // 仍可能让审批绑定 A，却让 artifactId 指向 B。
    if (!artifactReferenceHasMatchingContentIdentity(reference)) {
      context.addIssue({
        code: "custom",
        path: ["artifactId"],
        message: "artifact content identity 与摘要不一致",
      });
    }
  });

const sourceScopeValueSchema = sourceScopeSchema.transform(
  (scope): SourceScope => scope,
);

const runBudgetValueSchema = runBudgetSchema.transform(
  (budget): RunBudget => budget,
);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const sourceSnapshotReferenceSchema = z
  .object({
    snapshotId: z.string().regex(/^source-sha256:[a-f0-9]{64}$/),
    sha256: sha256Schema,
    mediaType: z.literal("text/plain; charset=utf-8"),
    byteLength: z.number().int().nonnegative(),
    relativePath: z.string().min(1),
  })
  .strict()
  .superRefine((reference, context) => {
    if (!sourceSnapshotHasMatchingContentIdentity(reference)) {
      context.addIssue({
        code: "custom",
        path: ["snapshotId"],
        message: "Source Snapshot identity、摘要或路径不一致",
      });
    }
  })
  .transform((reference): SourceSnapshotReference => reference);

const sourceAccessDenialCodeSchema = z.enum([
  "invalid_root",
  "invalid_path",
  "invalid_line_range",
  "line_range_out_of_bounds",
  "path_escape",
  "symlink_escape",
  "symlink_path",
  "excluded_path",
  "secret_path",
  "extension_not_allowed",
  "binary_file",
  "file_too_large",
  "source_budget_exceeded",
  "line_range_too_large",
]);

const sourceAccessFailureCodeSchema = z.enum([
  "root_changed",
  "path_changed_during_read",
  "source_changed_during_read",
  "source_not_found",
  "source_not_file",
  "source_io_error",
]);

const sourceReadObservationFields = {
  observationId: z.string().trim().min(1),
  toolCallId: z.string().trim().min(1),
  toolName: z.literal("read_source"),
  requestHash: sha256Schema,
  observedAt: z.iso.datetime(),
};

export const sourceReadObservationSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        ...sourceReadObservationFields,
        status: z.literal("succeeded"),
        rootIndex: z.number().int().nonnegative(),
        relativePath: z.string().min(1),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        totalLines: z.number().int().positive(),
        excerpt: z.string(),
        excerptHash: sha256Schema,
        sourceSnapshot: sourceSnapshotReferenceSchema,
        byteLength: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        ...sourceReadObservationFields,
        status: z.literal("denied"),
        code: sourceAccessDenialCodeSchema,
      })
      .strict(),
    z
      .object({
        ...sourceReadObservationFields,
        status: z.literal("failed"),
        code: sourceAccessFailureCodeSchema,
      })
      .strict(),
  ])
  .transform((observation): SourceReadObservation => observation);

const evidenceRecordSchema = z
  .object({
    evidenceId: z.string().trim().min(1),
    kind: z.literal("source_fact"),
    observationId: z.string().trim().min(1),
    toolCallId: z.string().trim().min(1),
    sourceSnapshotId: z.string().regex(/^source-sha256:[a-f0-9]{64}$/),
    rootIndex: z.number().int().nonnegative(),
    relativePath: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    excerptHash: sha256Schema,
    recordedAt: z.iso.datetime(),
  })
  .strict()
  .transform((evidence): EvidenceRecord => evidence);

const claimSchema = z
  .object({
    claimId: z.string().trim().min(1),
    kind: z.enum(["source_fact", "inference", "design_recommendation"]),
    text: z
      .string()
      .trim()
      .min(1)
      .refine(
        (text) => !hasPreRenderedCitationToken(text),
        "Claim 不能包含预渲染 citation",
      ),
    evidenceIds: z.array(z.string().trim().min(1)),
    recordedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (claim) =>
      claim.kind === "design_recommendation" || claim.evidenceIds.length > 0,
    "source fact 与 inference 必须引用 Evidence",
  )
  .transform((claim): Claim => claim);

const learningArtifactProposalSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .refine(
        (title) => !hasPreRenderedCitationToken(title),
        "标题不能包含预渲染 citation",
      ),
    summary: z
      .string()
      .trim()
      .min(1)
      .refine(
        isSingleSentenceConclusion,
        "Conclusion 必须是单行单句",
      )
      .refine(
        (summary) => !hasPreRenderedCitationToken(summary),
        "摘要不能包含预渲染 citation",
      ),
    claimIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .transform((proposal): LearningArtifactProposal => proposal);

const evaluatorIdentitySchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  promptVersion: z.string().trim().min(1),
}).strict().transform((identity): EvaluatorIdentity => identity);

const evaluatorVerdictSchema = z.enum([
  "supported",
  "partially_supported",
  "unsupported",
  "contradicted",
  "uncertain",
]);

const evaluatorReviewSchema = z.object({
  verdicts: z.array(z.object({
    claimId: z.string().trim().min(1),
    verdict: evaluatorVerdictSchema,
  }).strict()),
}).strict().transform((review): EvaluatorReview => review);

const evaluatorReviewRequestSchema = z.object({
  question: z.string().trim().min(1),
  claims: z.array(z.object({
    claimId: z.string().trim().min(1),
    kind: z.enum(["source_fact", "inference", "design_recommendation"]),
    text: z.string().trim().min(1),
    evidence: z.array(z.object({
      evidenceId: z.string().trim().min(1),
      sourceSnapshotId: z.string().trim().min(1),
      relativePath: z.string().trim().min(1),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      excerpt: z.string(),
    }).strict()),
  }).strict()),
}).strict().transform((request): EvaluatorReviewRequest => request);

const evaluatorReviewFailureSchema = z.object({
  attempt: z.number().int().positive(),
  code: z.literal("evaluation_failed"),
  failedAt: z.iso.datetime(),
}).strict().transform((failure): EvaluatorReviewFailure => failure);

const publicationEvaluationSchema = z.union([
  z.object({
    kind: z.literal("reviewed"),
    review: evaluatorReviewSchema,
    reviewArtifact: artifactReferenceSchema,
    identity: z.object({
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      promptVersion: z.string().trim().min(1),
      inputHash: sha256Schema,
      reviewArtifactHash: sha256Schema,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("skipped"),
    identity: z.object({
      skipId: z.string().trim().min(1),
      skippedBy: z.literal("user-command"),
      skippedAt: z.iso.datetime(),
    }).strict(),
  }).strict(),
]).transform((evaluation): PublicationEvaluation => evaluation);

const publicationApprovalSummarySchema = z.object({
  hardGate: z.object({
    status: z.literal("passed"),
    claimCount: z.number().int().positive(),
    evidenceCount: z.number().int().nonnegative(),
  }).strict(),
  advisoryWarnings: z.array(z.union([
    z.object({
      kind: z.literal("claim_verdict"),
      claimId: z.string().trim().min(1),
      verdict: z.enum([
        "partially_supported",
        "unsupported",
        "contradicted",
        "uncertain",
      ]),
    }).strict(),
    z.object({
      kind: z.literal("evaluator_skipped"),
      skipId: z.string().trim().min(1),
    }).strict(),
  ])),
}).strict().transform((summary): PublicationApprovalSummary => summary);

const publicationTargetSchema = z
  .object({
    outputRootCanonicalPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "Output Root 必须是绝对路径"),
    outputRootDevice: z.string().regex(/^\d+$/),
    outputRootInode: z.string().regex(/^\d+$/),
    targetCanonicalPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "Learning Artifact target 必须是绝对路径"),
    parentDevice: z.string().regex(/^\d+$/),
    parentInode: z.string().regex(/^\d+$/),
  })
  .strict()
  .transform((target): PublicationTarget => target);

const publicationApprovalBindingSchema = z
  .object({
    draftHash: sha256Schema,
    evaluationKind: z.enum(["reviewed", "skipped"]),
    evaluationHash: sha256Schema,
    outputRootCanonicalPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "Output Root 必须是绝对路径"),
    outputRootDevice: z.string().regex(/^\d+$/),
    outputRootInode: z.string().regex(/^\d+$/),
    targetCanonicalPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "publication target 必须是绝对路径"),
    parentDevice: z.string().regex(/^\d+$/),
    parentInode: z.string().regex(/^\d+$/),
    bindingHash: sha256Schema,
  })
  .strict()
  .transform((binding): PublicationApprovalBinding => binding);

const publicationApprovalReceiptSchema = z
  .object({
    approvalId: z.string().trim().min(1),
    kind: z.literal("publication"),
    approvedBy: z.literal("user-command"),
    approvedAt: z.iso.datetime(),
    draftHash: sha256Schema,
    evaluationKind: z.enum(["reviewed", "skipped"]),
    evaluationHash: sha256Schema,
    outputRootCanonicalPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "Output Root 必须是绝对路径"),
    outputRootDevice: z.string().regex(/^\d+$/),
    outputRootInode: z.string().regex(/^\d+$/),
    targetCanonicalPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "publication receipt target 必须是绝对路径"),
    parentDevice: z.string().regex(/^\d+$/),
    parentInode: z.string().regex(/^\d+$/),
    bindingHash: sha256Schema,
  })
  .strict()
  .transform((receipt): PublicationApprovalReceipt => receipt);

const publishedLearningArtifactSchema = z
  .object({
    targetCanonicalPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "published target 必须是绝对路径"),
    sha256: sha256Schema,
    publishedAt: z.iso.datetime(),
  })
  .strict()
  .transform((artifact): PublishedLearningArtifact => artifact);

const pendingPublicationEffectSchema = z.object({
  effectId: z.string().regex(/^publication-effect:[a-f0-9]{64}$/),
  runId: z.string().trim().min(1),
  draftHash: sha256Schema,
  targetCanonicalPath: z.string().min(1).refine(isAbsolute),
  publicationApprovalId: z.string().trim().min(1),
  status: z.literal("pending"),
  preparedAt: z.iso.datetime(),
}).strict().transform((effect): PendingPublicationEffect => effect);

const publicationEffectIdentityFields = {
  effectId: z.string().regex(/^publication-effect:[a-f0-9]{64}$/),
  runId: z.string().trim().min(1),
  draftHash: sha256Schema,
  targetCanonicalPath: z.string().min(1).refine(isAbsolute),
  publicationApprovalId: z.string().trim().min(1),
  preparedAt: z.iso.datetime(),
};

const executingPublicationEffectSchema = z.object({
  ...publicationEffectIdentityFields,
  status: z.literal("executing"),
  executionStartedAt: z.iso.datetime(),
}).strict().transform((effect): ExecutingPublicationEffect => effect);

const unknownPublicationEffectSchema = z.object({
  ...publicationEffectIdentityFields,
  status: z.literal("unknown"),
  executionStartedAt: z.iso.datetime(),
  unknownAt: z.iso.datetime(),
  reason: z.enum(["interrupted_execution", "reconciliation_inconclusive"]),
}).strict().transform((effect): UnknownPublicationEffect => effect);

const conflictingPublicationEffectSchema = z.object({
  ...publicationEffectIdentityFields,
  status: z.literal("conflict"),
  executionStartedAt: z.iso.datetime(),
  conflictedAt: z.iso.datetime(),
  observedTargetHash: sha256Schema.optional(),
}).strict().transform((effect): ConflictingPublicationEffect => effect);

const succeededPublicationEffectSchema = z.object({
  ...publicationEffectIdentityFields,
  status: z.literal("succeeded"),
  executionStartedAt: z.iso.datetime(),
  succeededAt: z.iso.datetime(),
  settlement: z.enum(["direct", "reconciled"]),
}).strict().transform((effect): SucceededPublicationEffect => effect);

const planApprovalBindingSchema = z
  .object({
    questionHash: sha256Schema,
    planHash: sha256Schema,
    sourceScopeHash: sha256Schema,
    budgetVersion: z.string().trim().min(1),
    budgetHash: sha256Schema,
    experimentIdentityHash: sha256Schema.optional(),
    retryPolicyVersion: z.string().trim().min(1).optional(),
    retryPolicyHash: sha256Schema.optional(),
    bindingHash: sha256Schema,
  })
  .refine(
    (binding) =>
      (binding.retryPolicyVersion === undefined) ===
        (binding.retryPolicyHash === undefined),
    "Retry Policy version 与 hash 必须同时存在或同时省略",
  )
  .transform((binding): PlanApprovalBinding => binding);

const planApprovalReceiptSchema = z
  .object({
    approvalId: z.string().trim().min(1),
    kind: z.literal("plan"),
    approvedBy: z.literal("user-command"),
    approvedAt: z.iso.datetime(),
    bindingHash: sha256Schema,
    questionHash: sha256Schema,
    planHash: sha256Schema,
    sourceScopeHash: sha256Schema,
    budgetVersion: z.string().trim().min(1),
    budgetHash: sha256Schema,
    experimentIdentityHash: sha256Schema.optional(),
    retryPolicyVersion: z.string().trim().min(1).optional(),
    retryPolicyHash: sha256Schema.optional(),
  })
  .strict()
  .refine(
    (receipt) =>
      (receipt.retryPolicyVersion === undefined) ===
        (receipt.retryPolicyHash === undefined),
    "Retry Policy version 与 hash 必须同时存在或同时省略",
  )
  .transform((receipt): PlanApprovalReceipt => receipt);

const researchToolIntentSchema = z
  .object({
    intentId: z.string().trim().min(1),
    name: z.enum([
      "search_sources",
      "read_source",
      "record_evidence",
      "propose_claim",
      "complete_research",
    ]),
    input: z.json(),
  })
  .strict();

const runBudgetApprovalReceiptSchema = z.object({
  approvalId: z.string().trim().min(1),
  kind: z.literal("run_budget_extension"),
  approvedBy: z.literal("user-command"),
  approvedAt: z.iso.datetime(),
  previousBudgetVersion: z.string().trim().min(1),
  previousBudgetHash: sha256Schema,
  runBudgetVersion: z.string().trim().min(1),
  runBudgetHash: sha256Schema,
}).strict();

const modelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

const experimentIdentitySchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    adapterVersion: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    toolSchemaVersion: z.string().trim().min(1),
  })
  .strict()
  .transform((identity): ExperimentIdentity => identity);

const modelTurnSchema = z
  .object({
    turnId: z.string().trim().min(1),
    text: z.string(),
    evidenceGaps: z.array(z.string().trim().min(1)),
    finishReason: z.enum(["tool_calls", "stop"]),
    toolIntents: z.array(researchToolIntentSchema).min(1),
    usage: modelUsageSchema.optional(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .transform((turn): ModelTurn => turn);

const researchToolOutputSchema = z.union([
  z.object({
    searchResultArtifact: artifactReferenceSchema,
    matchCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({ sourceObservationId: z.string().trim().min(1) }).strict(),
  z.object({ evidenceId: z.string().trim().min(1) }).strict(),
  z.object({ claimId: z.string().trim().min(1) }).strict(),
  z.object({ unresolvedQuestions: z.array(z.string().trim().min(1)) }).strict(),
]);

const normalizedFailureSchema = z.object({
  category: z.enum([
    "infrastructure_transient",
    "model_contract",
    "model_permanent",
    "permission_denied",
    "stale_state",
    "tool_execution",
    "invariant_violation",
  ]),
  code: z.string().trim().min(1),
  retryAfterMs: z.number().int().nonnegative().optional(),
}).strict();

const researchToolObservationSchema = z
  .object({
    observationId: z.string().trim().min(1),
    toolCallId: z.string().trim().min(1),
    intentId: z.string().trim().min(1),
    toolName: researchToolIntentSchema.shape.name,
    status: z.enum(["succeeded", "invalid", "denied", "failed"]),
    code: z.string().trim().min(1).optional(),
    failure: normalizedFailureSchema.optional(),
    summary: z.string().trim().min(1),
    output: researchToolOutputSchema.optional(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .transform((observation): ResearchToolObservation => observation);

const retryAttemptCommonFields = {
  attemptId: z.string().trim().min(1),
  retrySequenceId: z.string().trim().min(1),
  retrySequenceKind: z.enum(["model_turn", "search_sources"]),
  attemptNumber: z.number().int().positive(),
  retryPolicy: retryPolicySchema,
  startedAt: z.iso.datetime(),
  toolCallId: z.string().trim().min(1).optional(),
  intentId: z.string().trim().min(1).optional(),
  latestSteering: z.string().trim().min(1).optional(),
};

const inProgressRetryAttemptSchema = z.object({
  ...retryAttemptCommonFields,
  outcome: z.literal("in_progress"),
}).strict();

const completedRetryAttemptSchema = z.object({
  ...retryAttemptCommonFields,
  outcome: z.enum([
    "succeeded",
    "retryable_failure",
    "retry_exhausted",
    "permanent_failure",
  ]),
  completedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  failure: normalizedFailureSchema.optional(),
  retryDelayMs: z.number().int().nonnegative().optional(),
}).strict();

const retryAttemptSchema = z.union([
  inProgressRetryAttemptSchema,
  completedRetryAttemptSchema,
]).transform((attempt): RetryAttempt => attempt);

const remainingRunBudgetSchema = z.object({
  modelTurns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  distinctSources: z.number().int().nonnegative(),
  sourceBytes: z.number().int().nonnegative(),
  wallTimeMs: z.number().int().nonnegative(),
}).strict();

const evidenceGateRepairSchema = z.object({
  repairId: z.string().trim().min(1),
  code: z.enum([
    "invalid_claim_selection",
    "unknown_claim_id",
    "claim_evidence_required",
    "unknown_evidence_id",
    "invalid_evidence_kind",
    "lineage_mismatch",
    "snapshot_integrity_failure",
    "snapshot_range_invalid",
    "excerpt_mismatch",
    "approval_invalid",
    "proposal_invalid",
    "budget_violation",
  ]),
  summary: z.string().trim().min(1),
  recommendedAction: z.string().trim().min(1),
  artifactProposalTurnConsumed: z.boolean(),
  requestedAt: z.iso.datetime(),
}).strict().transform((repair): EvidenceGateRepair => repair);

const evidenceBackedStateFields = {
  planArtifact: artifactReferenceSchema,
  approvalReceipt: planApprovalReceiptSchema,
  sourceReadObservations: z.array(sourceReadObservationSchema),
  sourceBytesRead: z.number().int().nonnegative(),
  evidenceRecords: z.array(evidenceRecordSchema),
  claims: z.array(claimSchema),
  modelTurns: z.array(modelTurnSchema),
  researchToolObservations: z.array(researchToolObservationSchema),
  evidenceGaps: z.array(z.string().trim().min(1)),
  evidenceGateRepairs: z.array(evidenceGateRepairSchema).default([]),
  pendingToolIntents: z.array(researchToolIntentSchema),
  latestSteering: z.string().trim().min(1).optional(),
  researchStartedAt: z.iso.datetime().optional(),
  suspendedDurationMs: z.number().int().nonnegative().default(0),
  retryAttempts: z.array(retryAttemptSchema),
};

const researchCompletionSchema = z.object({
  unresolvedQuestions: z.array(z.string().trim().min(1)),
  completedAt: z.iso.datetime(),
}).strict();

const publicationCommonStateFields = {
  planArtifact: artifactReferenceSchema,
  approvalReceipt: planApprovalReceiptSchema,
  sourceReadObservations: z.array(sourceReadObservationSchema),
  sourceBytesRead: z.number().int().nonnegative(),
  evidenceRecords: z.array(evidenceRecordSchema),
  claims: z.array(claimSchema),
  draftArtifact: artifactReferenceSchema,
  proposal: learningArtifactProposalSchema,
  evaluation: publicationEvaluationSchema,
  publicationTarget: publicationTargetSchema,
  publicationBinding: publicationApprovalBindingSchema,
  publicationApprovalSummary: publicationApprovalSummarySchema,
};

const legacyExplicitPublicationFields = {
  ...publicationCommonStateFields,
  researchOrigin: z.literal("legacy_explicit"),
  modelTurns: z.tuple([]),
  researchToolObservations: z.tuple([]),
  evidenceGaps: z.tuple([]),
  evidenceGateRepairs: z.array(evidenceGateRepairSchema).default([]),
  pendingToolIntents: z.tuple([]),
  suspendedDurationMs: z.number().int().nonnegative().default(0),
  retryAttempts: z.array(retryAttemptSchema),
};

const researchLoopPublicationFields = {
  ...publicationCommonStateFields,
  researchOrigin: z.literal("research_loop"),
  modelTurns: z.tuple([modelTurnSchema], modelTurnSchema),
  researchToolObservations: z.tuple(
    [researchToolObservationSchema],
    researchToolObservationSchema,
  ),
  evidenceGaps: z.array(z.string().trim().min(1)),
  evidenceGateRepairs: z.array(evidenceGateRepairSchema).default([]),
  pendingToolIntents: z.tuple([]),
  latestSteering: z.string().trim().min(1).optional(),
  researchStartedAt: z.iso.datetime(),
  suspendedDurationMs: z.number().int().nonnegative().default(0),
  completion: researchCompletionSchema,
  retryAttempts: z.array(retryAttemptSchema),
};

const researchingRunStateSchema = z.object({
  type: z.literal("researching"),
  ...evidenceBackedStateFields,
});

const researchCompleteRunStateSchema = z.object({
  type: z.literal("research_complete"),
  ...evidenceBackedStateFields,
  completion: researchCompletionSchema,
});

const evaluatorPendingCommonFields = {
  proposal: learningArtifactProposalSchema,
  publicationTarget: publicationTargetSchema,
  evaluatorInputHash: sha256Schema,
  evaluatorIdentity: evaluatorIdentitySchema,
  evaluatorFailures: z.tuple(
    [evaluatorReviewFailureSchema],
    evaluatorReviewFailureSchema,
  ),
};

const readyToPublishRunStateSchema = z.union([
  z.object({
    type: z.literal("ready_to_publish"),
    ...legacyExplicitPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
  }).strict(),
  z.object({
    type: z.literal("ready_to_publish"),
    ...researchLoopPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
  }).strict(),
]);

const publicationPendingRunStateSchema = z.union([
  z.object({
    type: z.literal("publication_pending"),
    ...legacyExplicitPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: pendingPublicationEffectSchema,
  }).strict(),
  z.object({
    type: z.literal("publication_pending"),
    ...researchLoopPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: pendingPublicationEffectSchema,
  }).strict(),
]);

const publicationExecutingRunStateSchema = z.union([
  z.object({
    type: z.literal("publication_executing"),
    ...legacyExplicitPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: executingPublicationEffectSchema,
  }).strict(),
  z.object({
    type: z.literal("publication_executing"),
    ...researchLoopPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: executingPublicationEffectSchema,
  }).strict(),
]);

const publicationUnknownRunStateSchema = z.union([
  z.object({
    type: z.literal("publication_unknown"),
    ...legacyExplicitPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: unknownPublicationEffectSchema,
  }).strict(),
  z.object({
    type: z.literal("publication_unknown"),
    ...researchLoopPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: unknownPublicationEffectSchema,
  }).strict(),
]);

const publicationConflictRunStateSchema = z.union([
  z.object({
    type: z.literal("publication_conflict"),
    ...legacyExplicitPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: conflictingPublicationEffectSchema,
  }).strict(),
  z.object({
    type: z.literal("publication_conflict"),
    ...researchLoopPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: conflictingPublicationEffectSchema,
  }).strict(),
]);

const pausableRunStateSchema = z.union([
  researchingRunStateSchema,
  researchCompleteRunStateSchema,
  readyToPublishRunStateSchema,
]);

const runStateSchema: z.ZodType<ResearchRunState> = z.lazy(() => z.union([
  z.object({ type: z.literal("created") }),
  z.object({
    type: z.literal("planning"),
    startedAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("waiting_plan_approval"),
    planArtifact: artifactReferenceSchema,
    approvalBinding: planApprovalBindingSchema,
    proposedAt: z.iso.datetime(),
  }),
  researchingRunStateSchema,
  researchCompleteRunStateSchema,
  z.object({
    type: z.literal("waiting_evaluator_resolution"),
    ...legacyExplicitPublicationFields,
    ...evaluatorPendingCommonFields,
  }).omit({
    draftArtifact: true,
    evaluation: true,
    publicationBinding: true,
  }).strict(),
  z.object({
    type: z.literal("waiting_evaluator_resolution"),
    ...researchLoopPublicationFields,
    ...evaluatorPendingCommonFields,
  }).omit({
    draftArtifact: true,
    evaluation: true,
    publicationBinding: true,
  }).strict(),
  z.object({
    type: z.literal("budget_exhausted"),
    ...evidenceBackedStateFields,
    researchOutcome: z.literal("incomplete"),
    exhaustedDimension: z.enum([
      "model_turns",
      "tool_calls",
      "distinct_sources",
      "source_bytes",
      "wall_time",
    ]),
    remainingBudget: remainingRunBudgetSchema,
  }),
  z.object({
    type: z.literal("retry_exhausted"),
    ...evidenceBackedStateFields,
    retrySequenceId: z.string().trim().min(1),
    retrySequenceKind: z.enum(["model_turn", "search_sources"]),
    attemptsUsed: z.number().int().positive(),
    failure: normalizedFailureSchema,
  }),
  z.object({
    type: z.literal("failed"),
    ...evidenceBackedStateFields,
    retrySequenceId: z.string().trim().min(1),
    retrySequenceKind: z.enum(["model_turn", "search_sources"]),
    failure: normalizedFailureSchema,
  }),
  z.object({
    type: z.literal("budget_exhausted"),
    ...evidenceBackedStateFields,
    researchOutcome: z.literal("research_complete"),
    completion: researchCompletionSchema,
    exhaustedDimension: z.enum([
      "model_turns",
      "tool_calls",
      "distinct_sources",
      "source_bytes",
      "wall_time",
    ]),
    remainingBudget: remainingRunBudgetSchema,
  }),
  z.object({
    type: z.literal("waiting_publication_approval"),
    ...legacyExplicitPublicationFields,
    proposedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    type: z.literal("waiting_publication_approval"),
    ...researchLoopPublicationFields,
    proposedAt: z.iso.datetime(),
  }).strict(),
  readyToPublishRunStateSchema,
  publicationPendingRunStateSchema,
  publicationExecutingRunStateSchema,
  publicationUnknownRunStateSchema,
  publicationConflictRunStateSchema,
  z.object({
    type: z.literal("completed"),
    ...legacyExplicitPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: succeededPublicationEffectSchema,
    learningArtifact: publishedLearningArtifactSchema,
  }).strict(),
  z.object({
    type: z.literal("completed"),
    ...researchLoopPublicationFields,
    publicationReceipt: publicationApprovalReceiptSchema,
    publicationEffect: succeededPublicationEffectSchema,
    learningArtifact: publishedLearningArtifactSchema,
  }).strict(),
  z.object({
    type: z.literal("user_paused"),
    suspendedState: pausableRunStateSchema,
    pausedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    type: z.literal("cancelled"),
    cancelledState: z.lazy(() => z.union([
      z.object({ type: z.literal("created") }),
      z.object({ type: z.literal("planning"), startedAt: z.iso.datetime() }),
      z.object({
        type: z.literal("waiting_plan_approval"),
        planArtifact: artifactReferenceSchema,
        approvalBinding: planApprovalBindingSchema,
        proposedAt: z.iso.datetime(),
      }),
      researchingRunStateSchema,
      researchCompleteRunStateSchema,
      z.object({
        type: z.literal("waiting_evaluator_resolution"),
        ...legacyExplicitPublicationFields,
        ...evaluatorPendingCommonFields,
      }).omit({
        draftArtifact: true,
        evaluation: true,
        publicationBinding: true,
      }).strict(),
      z.object({
        type: z.literal("waiting_evaluator_resolution"),
        ...researchLoopPublicationFields,
        ...evaluatorPendingCommonFields,
      }).omit({
        draftArtifact: true,
        evaluation: true,
        publicationBinding: true,
      }).strict(),
      z.object({
        type: z.literal("budget_exhausted"),
        ...evidenceBackedStateFields,
        researchOutcome: z.literal("incomplete"),
        exhaustedDimension: z.enum([
          "model_turns", "tool_calls", "distinct_sources", "source_bytes", "wall_time",
        ]),
        remainingBudget: remainingRunBudgetSchema,
      }),
      z.object({
        type: z.literal("budget_exhausted"),
        ...evidenceBackedStateFields,
        researchOutcome: z.literal("research_complete"),
        completion: researchCompletionSchema,
        exhaustedDimension: z.enum([
          "model_turns", "tool_calls", "distinct_sources", "source_bytes", "wall_time",
        ]),
        remainingBudget: remainingRunBudgetSchema,
      }),
      z.object({
        type: z.literal("retry_exhausted"),
        ...evidenceBackedStateFields,
        retrySequenceId: z.string().trim().min(1),
        retrySequenceKind: z.enum(["model_turn", "search_sources"]),
        attemptsUsed: z.number().int().positive(),
        failure: normalizedFailureSchema,
      }),
      z.object({
        type: z.literal("waiting_publication_approval"),
        ...legacyExplicitPublicationFields,
        proposedAt: z.iso.datetime(),
      }).strict(),
      z.object({
        type: z.literal("waiting_publication_approval"),
        ...researchLoopPublicationFields,
        proposedAt: z.iso.datetime(),
      }).strict(),
      readyToPublishRunStateSchema,
      publicationPendingRunStateSchema,
      z.object({
        type: z.literal("user_paused"),
        suspendedState: pausableRunStateSchema,
        pausedAt: z.iso.datetime(),
      }).strict(),
    ])),
    cancelledAt: z.iso.datetime(),
  }).strict(),
]));

const runProjectionSchema = z.object({
  runId: z.string().min(1),
  question: z.string().min(1),
  sourceScope: sourceScopeValueSchema,
  runBudget: runBudgetValueSchema,
  runBudgetApprovalReceipts: z.array(runBudgetApprovalReceiptSchema).default([]),
  experimentIdentity: experimentIdentitySchema.optional(),
  retryPolicy: retryPolicySchema.optional(),
  state: runStateSchema,
  lastEventSequence: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const eventEnvelopeSchema = {
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
};

const researchRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventEnvelopeSchema,
      type: z.literal("run_created"),
      payload: z.object({
        question: z.string().trim().min(1),
        sourceScope: sourceScopeValueSchema,
        runBudget: runBudgetValueSchema,
        experimentIdentity: experimentIdentitySchema.optional(),
        retryPolicy: retryPolicySchema.optional(),
    }),
  }),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("planning_started"),
    payload: z.object({}),
  }),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("plan_proposed"),
    payload: z.object({
      planArtifact: artifactReferenceSchema,
      approvalBinding: planApprovalBindingSchema,
    }),
  }),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("plan_approved"),
    payload: z.object({
      approvalReceipt: planApprovalReceiptSchema,
    }),
  }),
  z
    .object({
      ...eventEnvelopeSchema,
      type: z.literal("source_read_observed"),
      payload: z
        .object({
          observation: sourceReadObservationSchema,
          researchObservation: researchToolObservationSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("publication_effect_prepared"),
    payload: z.object({
      publicationEffect: pendingPublicationEffectSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("publication_effect_execution_started"),
    payload: z.object({
      publicationEffect: executingPublicationEffectSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("publication_effect_unknown"),
    payload: z.object({
      publicationEffect: unknownPublicationEffectSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("publication_effect_conflicted"),
    payload: z.object({
      publicationEffect: conflictingPublicationEffectSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("publication_effect_retry_scheduled"),
    payload: z.object({
      publicationEffect: pendingPublicationEffectSchema,
    }).strict(),
  }).strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      type: z.literal("evidence_recorded"),
      payload: z
        .object({
          evidence: evidenceRecordSchema,
          researchObservation: researchToolObservationSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      type: z.literal("claim_recorded"),
      payload: z
        .object({
          claim: claimSchema,
          researchObservation: researchToolObservationSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("retry_attempt_started"),
    payload: z.object({ attempt: inProgressRetryAttemptSchema }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("retry_attempt_failed"),
    payload: z.object({ attempt: completedRetryAttemptSchema }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("run_retry_exhausted"),
    payload: z.object({
      retrySequenceId: z.string().trim().min(1),
      retrySequenceKind: z.enum(["model_turn", "search_sources"]),
      attemptsUsed: z.number().int().positive(),
      failure: normalizedFailureSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("run_failed"),
    payload: z.object({
      retrySequenceId: z.string().trim().min(1),
      retrySequenceKind: z.enum(["model_turn", "search_sources"]),
      failure: normalizedFailureSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("model_turn_completed"),
    payload: z.object({
      turn: modelTurnSchema,
      generationStartedAt: z.iso.datetime(),
      latestSteering: z.string().trim().min(1).optional(),
      attempt: completedRetryAttemptSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("research_tool_observed"),
    payload: z.object({
      observation: researchToolObservationSchema,
      attempt: completedRetryAttemptSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("research_completed"),
    payload: z.object({
      completion: z.object({
        unresolvedQuestions: z.array(z.string().trim().min(1)),
        completedAt: z.iso.datetime(),
      }).strict(),
      observation: researchToolObservationSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("evidence_gate_repair_requested"),
    payload: z.object({
      repair: evidenceGateRepairSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("evaluator_review_failed"),
    payload: z.object({
      proposal: learningArtifactProposalSchema,
      publicationTarget: publicationTargetSchema,
      evaluatorInputHash: sha256Schema,
      evaluatorIdentity: evaluatorIdentitySchema,
      failure: evaluatorReviewFailureSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("run_budget_exhausted"),
    payload: z.object({
      exhaustedDimension: z.enum([
        "model_turns",
        "tool_calls",
        "distinct_sources",
        "source_bytes",
        "wall_time",
      ]),
      remainingBudget: remainingRunBudgetSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("run_budget_extended"),
    payload: z.object({
      runBudget: runBudgetValueSchema,
      approvalReceipt: runBudgetApprovalReceiptSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("run_paused"),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("run_resumed"),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("run_cancelled"),
    payload: z.object({}).strict(),
  }).strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      type: z.literal("learning_artifact_draft_proposed"),
      payload: z
        .object({
          draftArtifact: artifactReferenceSchema,
          proposal: learningArtifactProposalSchema,
          evaluation: publicationEvaluationSchema,
          publicationTarget: publicationTargetSchema,
          publicationBinding: publicationApprovalBindingSchema,
          publicationApprovalSummary: publicationApprovalSummarySchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      type: z.literal("publication_approved"),
      payload: z
        .object({
          publicationReceipt: publicationApprovalReceiptSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      type: z.literal("learning_artifact_published"),
      payload: z
        .object({
          publicationEffect: succeededPublicationEffectSchema,
          learningArtifact: publishedLearningArtifactSchema,
        })
        .strict(),
    })
    .strict(),
]);

export function parseSourceScope(input: unknown): SourceScope {
  return sourceScopeSchema.parse(input);
}

export function parseRequestedSourceScope(input: unknown): RequestedSourceScope {
  return requestedSourceScopeSchema.parse(input);
}

export function parseResearchPlan(input: unknown): ResearchPlan {
  return researchPlanSchema.parse(input);
}

export function parseLearningArtifactProposal(
  input: unknown,
): LearningArtifactProposal {
  return learningArtifactProposalSchema.parse(input);
}

export function parseEvaluatorReview(input: unknown): EvaluatorReview {
  return evaluatorReviewSchema.parse(input);
}

export function parseEvaluatorReviewRequest(
  input: unknown,
): EvaluatorReviewRequest {
  return evaluatorReviewRequestSchema.parse(input);
}

export function parseRunBudget(input: unknown): RunBudget {
  return runBudgetSchema.parse(input);
}

export function parseRetryPolicy(input: unknown): RetryPolicy {
  return retryPolicySchema.parse(input);
}

export function parseResearchRunEvent(input: unknown): ResearchRunEvent {
  return researchRunEventSchema.parse(input);
}

export function parseRunProjection(input: unknown): RunProjection {
  return runProjectionSchema.parse(input);
}
