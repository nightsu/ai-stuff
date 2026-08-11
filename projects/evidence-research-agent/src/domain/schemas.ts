import { isAbsolute } from "node:path";

import { z } from "zod";

import { artifactReferenceHasMatchingContentIdentity } from "./integrity.js";
import type {
  PlanApprovalBinding,
  PlanApprovalReceipt,
  ResearchPlan,
  ResearchRunEvent,
  RunBudget,
  RunProjection,
  SourceScope,
} from "./types.js";

export const sourceScopeSchema = z.object({
  roots: z
    .array(z.string().min(1).refine(isAbsolute, "Source Scope root 必须是绝对路径"))
    .min(1),
  exclusions: z.array(z.string().min(1)),
  allowedExtensions: z
    .array(z.string().regex(/^\.[A-Za-z0-9]+$/, "扩展名必须包含前导点"))
    .min(1),
  maxFileBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
});

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
]);

export function parseSourceScope(input: unknown): SourceScope {
  return sourceScopeSchema.parse(input);
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
