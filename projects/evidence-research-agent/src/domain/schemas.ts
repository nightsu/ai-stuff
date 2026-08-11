import { isAbsolute } from "node:path";

import { z } from "zod";

import type {
  ResearchPlan,
  ResearchRunEvent,
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

const artifactReferenceSchema = z.object({
  artifactId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  relativePath: z.string().min(1),
});

const sourceScopeValueSchema = sourceScopeSchema.transform(
  (scope): SourceScope => scope,
);

const runStateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("created") }),
  z.object({
    type: z.literal("planning"),
    startedAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("waiting_plan_approval"),
    planArtifact: artifactReferenceSchema,
    proposedAt: z.iso.datetime(),
  }),
]);

const runProjectionSchema = z.object({
  runId: z.string().min(1),
  question: z.string().min(1),
  sourceScope: sourceScopeValueSchema,
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
    payload: z.object({ planArtifact: artifactReferenceSchema }),
  }),
]);

export function parseSourceScope(input: unknown): SourceScope {
  return sourceScopeSchema.parse(input);
}

export function parseResearchPlan(input: unknown): ResearchPlan {
  return researchPlanSchema.parse(input);
}

export function parseResearchRunEvent(input: unknown): ResearchRunEvent {
  return researchRunEventSchema.parse(input);
}

export function parseRunProjection(input: unknown): RunProjection {
  return runProjectionSchema.parse(input);
}
