import { describe, expect, it } from "vitest";

import {
  createPlanApprovalBinding,
  hashCanonicalJson,
} from "../../src/domain/integrity.js";
import {
  IllegalRunEventError,
  reduceRunEvents,
} from "../../src/domain/reducer.js";
import { parseResearchRunEvent } from "../../src/domain/schemas.js";
import type {
  PlanApprovalBinding,
  ResearchRunEvent,
  RunBudget,
  SourceScope,
} from "../../src/domain/types.js";

const question = "不得泄露的测试问题";
const sourceScope: SourceScope = {
  roots: ["/private/sensitive-source"],
  exclusions: ["**/.git/**"],
  allowedExtensions: [".md"],
  maxFileBytes: 256_000,
  maxTotalBytes: 2_000_000,
};
const runBudget: RunBudget = {
  version: "budget-v1",
  maxModelTurns: 8,
  maxToolCalls: 24,
  maxDistinctSources: 12,
  maxSourceBytes: 2_000_000,
  maxWallTimeMs: 300_000,
};
const planHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const approvalBinding = createPlanApprovalBinding({
  question,
  planHash,
  sourceScope,
  runBudget,
});

const componentFields = [
  "questionHash",
  "planHash",
  "sourceScopeHash",
  "budgetVersion",
  "budgetHash",
] as const;

describe("plan approval binding replay", () => {
  it.each(componentFields)(
    "rejects a self-consistent tampered %s",
    (field) => {
      const replacement =
        field === "budgetVersion"
          ? "budget-v2"
          : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const tampered = replaceBindingComponent(
        approvalBinding,
        field,
        replacement,
      );

      expectReplayToRejectWithoutSensitiveDetails(createEvents(tampered));
    },
  );

  it("rejects a tampered aggregate bindingHash", () => {
    expectReplayToRejectWithoutSensitiveDetails(
      createEvents({
        ...approvalBinding,
        bindingHash:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    );
  });

  it("rejects a plan artifact hash that no longer matches the binding", () => {
    const events = createEvents(approvalBinding);
    const planProposed = events[2];
    if (planProposed?.type !== "plan_proposed") {
      throw new Error("测试夹具缺少 plan_proposed 事件");
    }
    events[2] = {
      ...planProposed,
      payload: {
        ...planProposed.payload,
        planArtifact: {
          ...planProposed.payload.planArtifact,
          artifactId:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      },
    };

    expectReplayToRejectWithoutSensitiveDetails(events);
  });
});

describe("artifact content identity", () => {
  it("rejects mismatched artifactId and sha256 at the schema boundary", () => {
    const events = createArtifactIdentityMismatchEvents();
    expect(() => parseResearchRunEvent(events[2])).toThrowError(
      /artifact content identity 与摘要不一致/,
    );
  });

  it("rejects mismatched artifactId and sha256 during direct replay", () => {
    const events = createArtifactIdentityMismatchEvents();

    try {
      reduceRunEvents(events);
      throw new Error("测试要求 reducer 拒绝不一致的 artifact identity");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalRunEventError);
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toBe(
        "plan_proposed artifact identity 与内容摘要不一致",
      );
      expect(error.message).not.toContain(question);
      expect(error.message).not.toContain(sourceScope.roots[0]);
      expect(error.message).not.toContain(planHash);
    }
  });
});

function createEvents(
  binding: PlanApprovalBinding,
): ResearchRunEvent[] {
  return [
    {
      eventId: "event-001",
      runId: "run-001",
      sequence: 1,
      type: "run_created",
      occurredAt: "2026-08-12T08:00:00.000Z",
      payload: { question, sourceScope, runBudget },
    },
    {
      eventId: "event-002",
      runId: "run-001",
      sequence: 2,
      type: "planning_started",
      occurredAt: "2026-08-12T08:00:00.000Z",
      payload: {},
    },
    {
      eventId: "event-003",
      runId: "run-001",
      sequence: 3,
      type: "plan_proposed",
      occurredAt: "2026-08-12T08:00:01.000Z",
      payload: {
        planArtifact: {
          artifactId: `sha256:${planHash}`,
          sha256: planHash,
          mediaType: "application/json",
          byteLength: 128,
          relativePath: `artifacts/sha256/aa/${planHash}.json`,
        },
        approvalBinding: binding,
      },
    },
  ];
}

function createArtifactIdentityMismatchEvents(): ResearchRunEvent[] {
  const events = createEvents(approvalBinding);
  const planProposed = events[2];
  if (planProposed?.type !== "plan_proposed") {
    throw new Error("测试夹具缺少 plan_proposed 事件");
  }
  events[2] = {
    ...planProposed,
    payload: {
      ...planProposed.payload,
      planArtifact: {
        ...planProposed.payload.planArtifact,
        artifactId:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  };
  return events;
}

function replaceBindingComponent(
  binding: PlanApprovalBinding,
  field: (typeof componentFields)[number],
  replacement: string,
): PlanApprovalBinding {
  const tampered = { ...binding, [field]: replacement };
  return {
    ...tampered,
    bindingHash: hashCanonicalJson({
      questionHash: tampered.questionHash,
      planHash: tampered.planHash,
      sourceScopeHash: tampered.sourceScopeHash,
      budgetVersion: tampered.budgetVersion,
      budgetHash: tampered.budgetHash,
    }),
  };
}

function expectReplayToRejectWithoutSensitiveDetails(
  events: readonly ResearchRunEvent[],
): void {
  try {
    reduceRunEvents(events);
    throw new Error("测试要求 reducer 拒绝被篡改的审批绑定");
  } catch (error) {
    expect(error).toBeInstanceOf(IllegalRunEventError);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message).toBe("plan_proposed 审批绑定与当前 Run 事实不一致");
    expect(error.message).not.toContain(question);
    expect(error.message).not.toContain(sourceScope.roots[0]);
    expect(error.message).not.toContain(planHash);
  }
}
