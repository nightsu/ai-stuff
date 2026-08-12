import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  artifactReferenceHasMatchingContentIdentity,
  sourceSnapshotHasMatchingContentIdentity,
} from "./integrity.js";
import { hasPreRenderedCitationToken } from "./citation-safety.js";
import type {
  Claim,
  EvidenceRecord,
  LearningArtifactProposal,
  ModelTurn,
  PlanApprovalBinding,
  PlanApprovalReceipt,
  PublicationApprovalBinding,
  PublicationApprovalReceipt,
  PublicationTarget,
  PublishedLearningArtifact,
  ReadSourceRequest,
  ResearchPlan,
  ResearchRunEvent,
  ResearchToolObservation,
  RequestedSourceScope,
  RunBudget,
  RunProjection,
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
    kind: z.literal("source_fact"),
    text: z
      .string()
      .trim()
      .min(1)
      .refine(
        (text) => !hasPreRenderedCitationToken(text),
        "Claim 不能包含预渲染 citation",
      ),
    evidenceIds: z.array(z.string().trim().min(1)).min(1),
    recordedAt: z.iso.datetime(),
  })
  .strict()
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
        (summary) => !hasPreRenderedCitationToken(summary),
        "摘要不能包含预渲染 citation",
      ),
    claimIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .transform((proposal): LearningArtifactProposal => proposal);

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

const planApprovalBindingSchema = z
  .object({
    questionHash: sha256Schema,
    planHash: sha256Schema,
    sourceScopeHash: sha256Schema,
    budgetVersion: z.string().trim().min(1),
    budgetHash: sha256Schema,
    bindingHash: sha256Schema,
  })
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
  })
  .strict()
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

const modelTurnSchema = z
  .object({
    turnId: z.string().trim().min(1),
    text: z.string(),
    evidenceGaps: z.array(z.string().trim().min(1)),
    finishReason: z.enum(["tool_calls", "stop"]),
    toolIntents: z.array(researchToolIntentSchema).min(1),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .transform((turn): ModelTurn => turn);

const researchToolOutputSchema = z.union([
  z.object({
    matches: z.array(
      z.object({
        rootIndex: z.number().int().nonnegative(),
        relativePath: z.string().min(1),
        lineNumber: z.number().int().positive(),
        lineText: z.string(),
      }).strict(),
    ),
  }).strict(),
  z.object({ sourceObservationId: z.string().trim().min(1) }).strict(),
  z.object({ evidenceId: z.string().trim().min(1) }).strict(),
  z.object({ claimId: z.string().trim().min(1) }).strict(),
  z.object({ unresolvedQuestions: z.array(z.string().trim().min(1)) }).strict(),
]);

const researchToolObservationSchema = z
  .object({
    observationId: z.string().trim().min(1),
    toolCallId: z.string().trim().min(1),
    intentId: z.string().trim().min(1),
    toolName: researchToolIntentSchema.shape.name,
    status: z.enum(["succeeded", "invalid", "denied", "failed"]),
    code: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1),
    output: researchToolOutputSchema.optional(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .transform((observation): ResearchToolObservation => observation);

const remainingRunBudgetSchema = z.object({
  modelTurns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  distinctSources: z.number().int().nonnegative(),
  sourceBytes: z.number().int().nonnegative(),
  wallTimeMs: z.number().int().nonnegative(),
}).strict();

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
  pendingToolIntents: z.array(researchToolIntentSchema),
  latestSteering: z.string().trim().min(1).optional(),
  researchStartedAt: z.iso.datetime().optional(),
  completion: z.object({
    unresolvedQuestions: z.array(z.string().trim().min(1)),
    completedAt: z.iso.datetime(),
  }).strict().optional(),
};

const runStateSchema = z.discriminatedUnion("type", [
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
  z.object({
    type: z.literal("researching"),
    ...evidenceBackedStateFields,
  }),
  z.object({
    type: z.literal("research_complete"),
    ...evidenceBackedStateFields,
    completion: evidenceBackedStateFields.completion.unwrap(),
  }),
  z.object({
    type: z.literal("budget_exhausted"),
    ...evidenceBackedStateFields,
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
    ...evidenceBackedStateFields,
    draftArtifact: artifactReferenceSchema,
    proposal: learningArtifactProposalSchema,
    publicationTarget: publicationTargetSchema,
    publicationBinding: publicationApprovalBindingSchema,
    proposedAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("ready_to_publish"),
    ...evidenceBackedStateFields,
    draftArtifact: artifactReferenceSchema,
    proposal: learningArtifactProposalSchema,
    publicationTarget: publicationTargetSchema,
    publicationBinding: publicationApprovalBindingSchema,
    publicationReceipt: publicationApprovalReceiptSchema,
  }),
  z.object({
    type: z.literal("completed"),
    ...evidenceBackedStateFields,
    draftArtifact: artifactReferenceSchema,
    proposal: learningArtifactProposalSchema,
    publicationTarget: publicationTargetSchema,
    publicationBinding: publicationApprovalBindingSchema,
    publicationReceipt: publicationApprovalReceiptSchema,
    learningArtifact: publishedLearningArtifactSchema,
  }),
]);

const runProjectionSchema = z.object({
  runId: z.string().min(1),
  question: z.string().min(1),
  sourceScope: sourceScopeValueSchema,
  runBudget: runBudgetValueSchema,
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
    type: z.literal("model_turn_completed"),
    payload: z.object({
      turn: modelTurnSchema,
      generationStartedAt: z.iso.datetime(),
      latestSteering: z.string().trim().min(1).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...eventEnvelopeSchema,
    type: z.literal("research_tool_observed"),
    payload: z.object({ observation: researchToolObservationSchema }).strict(),
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
  z
    .object({
      ...eventEnvelopeSchema,
      type: z.literal("learning_artifact_draft_proposed"),
      payload: z
        .object({
          draftArtifact: artifactReferenceSchema,
          proposal: learningArtifactProposalSchema,
          publicationTarget: publicationTargetSchema,
          publicationBinding: publicationApprovalBindingSchema,
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

export function parseRunBudget(input: unknown): RunBudget {
  return runBudgetSchema.parse(input);
}

export function parseResearchRunEvent(input: unknown): ResearchRunEvent {
  return researchRunEventSchema.parse(input);
}

export function parseRunProjection(input: unknown): RunProjection {
  return runProjectionSchema.parse(input);
}
