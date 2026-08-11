import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  artifactReferenceHasMatchingContentIdentity,
  sourceSnapshotHasMatchingContentIdentity,
} from "./integrity.js";
import type {
  PlanApprovalBinding,
  PlanApprovalReceipt,
  ReadSourceRequest,
  ResearchPlan,
  ResearchRunEvent,
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
    planArtifact: artifactReferenceSchema,
    approvalReceipt: planApprovalReceiptSchema,
    sourceReadObservations: z.array(sourceReadObservationSchema),
    sourceBytesRead: z.number().int().nonnegative(),
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

export function parseRunBudget(input: unknown): RunBudget {
  return runBudgetSchema.parse(input);
}

export function parseResearchRunEvent(input: unknown): ResearchRunEvent {
  return researchRunEventSchema.parse(input);
}

export function parseRunProjection(input: unknown): RunProjection {
  return runProjectionSchema.parse(input);
}
