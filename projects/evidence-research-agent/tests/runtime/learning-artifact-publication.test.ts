import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPlanApprovalBinding,
  createPublicationApprovalBinding,
  ResearchAgentRuntime,
  ScriptedModel,
} from "../../src/index.js";
import type { IdGenerator, RunBudget, SourceScope } from "../../src/index.js";
import {
  IllegalRunEventError,
  reduceRunEvents,
} from "../../src/domain/reducer.js";
import { SqliteRunStore } from "../../src/infrastructure/sqlite-run-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ResearchAgentRuntime Learning Artifact publication", () => {
  it("uses a ScriptedModel proposal to move approved plan through evidence gate, exact publication approval, and readable completed Markdown", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "journal-learning.md");

    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    expect(waiting.state).toMatchObject({
      type: "waiting_publication_approval",
      draftArtifact: {
        mediaType: "text/markdown; charset=utf-8",
      },
      publicationBinding: {
        draftHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetCanonicalPath: expect.any(String),
      },
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试要求等待 publication approval");
    }
    const targetCanonicalPath = waiting.state.publicationTarget.targetCanonicalPath;
    fixture.runtime.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      model: new ScriptedModel([]),
    });
    try {
      const ready = await restarted.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      expect(ready.state.type).toBe("ready_to_publish");

      const completed = await restarted.publishLearningArtifact({
        runId: fixture.runId,
      });
      expect(completed.state).toMatchObject({
        type: "completed",
        learningArtifact: {
          targetCanonicalPath,
          sha256: waiting.state.draftArtifact.sha256,
        },
      });
      await expect(readFile(targetCanonicalPath, "utf8")).resolves.toContain(
        "# Journal 的可恢复性",
      );
      await expect(readFile(targetCanonicalPath, "utf8")).resolves.toContain(
        "【Evidence: evidence-event-006】",
      );
      const trace = await restarted.traceRun({ runId: fixture.runId });
      expect(trace.events.slice(-5)).toEqual([
        expect.objectContaining({
          type: "evidence_recorded",
          evidenceId: "evidence-event-006",
        }),
        expect.objectContaining({
          type: "claim_recorded",
          claimId: "claim-event-007",
        }),
        expect.objectContaining({
          type: "learning_artifact_draft_proposed",
          draftArtifactId: waiting.state.draftArtifact.artifactId,
        }),
        expect.objectContaining({
          type: "publication_approved",
          publicationApprovalId: expect.stringMatching(/^approval-/),
        }),
        expect.objectContaining({
          type: "learning_artifact_published",
          learningArtifactSha256: waiting.state.draftArtifact.sha256,
        }),
      ]);
    } finally {
      restarted.close();
    }
  });

  it("blocks draft creation when a source read has no valid Evidence Record and leaves no draft artifact", async () => {
    const fixture = await createEvidenceReadyRun({ recordEvidenceAndClaim: false });
    const targetPath = join(fixture.outputDirectory, "blocked.md");

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath,
        }),
      ).rejects.toThrow(/Evidence/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(5);
    } finally {
      fixture.runtime.close();
    }
  });

  it("rejects a model-selected forged Claim ID before it can create a draft artifact", async () => {
    const fixture = await createEvidenceReadyRun({
      proposalClaimIds: ["claim-forged-by-model"],
    });

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "forged.md"),
        }),
      ).rejects.toThrow(/Evidence/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(7);
    } finally {
      fixture.runtime.close();
    }
  });

  it("invalidates a publication approval when its approved parent directory identity changes", async () => {
    const fixture = await createEvidenceReadyRun();
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath: join(fixture.outputDirectory, "moved-target.md"),
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试要求等待 publication approval");
    }
    const canonicalParent = dirname(
      waiting.state.publicationTarget.targetCanonicalPath,
    );
    await rename(canonicalParent, `${canonicalParent}-before-replace`);
    await mkdir(canonicalParent);

    try {
      await expect(
        fixture.runtime.approvePublication({
          runId: fixture.runId,
          bindingHash: waiting.state.publicationBinding.bindingHash,
        }),
      ).rejects.toThrow(/过期/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("waiting_publication_approval");
    } finally {
      fixture.runtime.close();
      await rm(`${canonicalParent}-before-replace`, {
        force: true,
        recursive: true,
      });
    }
  });

  it("rejects a direct replay that recomputes a binding around a forged draft hash", async () => {
    const fixture = await createEvidenceReadyRun();
    await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath: join(fixture.outputDirectory, "tampered.md"),
    });
    fixture.runtime.close();

    const store = new SqliteRunStore(fixture.runtimeHome);
    const events = structuredClone(store.readEvents(fixture.runId));
    store.close();
    const draftEvent = events.at(-1);
    if (draftEvent?.type !== "learning_artifact_draft_proposed") {
      throw new Error("测试夹具要求最后一个事件为 Learning Artifact draft");
    }
    const forgedSha256 = "f".repeat(64);
    const forgedArtifact = {
      ...draftEvent.payload.draftArtifact,
      artifactId: `sha256:${forgedSha256}`,
      sha256: forgedSha256,
    };
    events[events.length - 1] = {
      ...draftEvent,
      payload: {
        ...draftEvent.payload,
        draftArtifact: forgedArtifact,
        publicationBinding: createPublicationApprovalBinding({
          draftHash: forgedSha256,
          publicationTarget: draftEvent.payload.publicationTarget,
        }),
      },
    };

    expect(() => reduceRunEvents(events)).toThrow(IllegalRunEventError);
    expect(() => reduceRunEvents(events)).toThrow(
      /Learning Artifact draft 与 Evidence 或审批绑定不一致/,
    );
  });

  it("rolls back a Journal artifact reference when no matching private registry row is supplied", async () => {
    const runtimeHome = await createTemporaryDirectory("artifact-registry-");
    const store = new SqliteRunStore(runtimeHome);
    const runId = "run-artifact-registry";
    const sourceScope: SourceScope = {
      roots: [
        {
          canonicalPath: "/private/test-source",
          device: "10",
          inode: "20",
        },
      ],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 4_096,
      maxTotalBytes: 4_096,
    };
    const planHash = "a".repeat(64);
    const budget = runBudget();
    const planArtifact = {
      artifactId: `sha256:${planHash}`,
      sha256: planHash,
      mediaType: "application/json",
      byteLength: 1,
      relativePath: `artifacts/sha256/aa/${planHash}.json`,
    } as const;

    try {
      store.appendEvents(runId, 0, [
        {
          eventId: "event-registry-001",
          runId,
          sequence: 1,
          type: "run_created",
          occurredAt: "2026-08-12T09:10:00.000Z",
          payload: {
            question: "测试 artifact registry 原子对应",
            sourceScope,
            runBudget: budget,
          },
        },
        {
          eventId: "event-registry-002",
          runId,
          sequence: 2,
          type: "planning_started",
          occurredAt: "2026-08-12T09:10:00.000Z",
          payload: {},
        },
      ]);
      expect(() =>
        store.appendEvents(runId, 2, [
          {
            eventId: "event-registry-003",
            runId,
            sequence: 3,
            type: "plan_proposed",
            occurredAt: "2026-08-12T09:10:01.000Z",
            payload: {
              planArtifact,
              approvalBinding: createPlanApprovalBinding({
                question: "测试 artifact registry 原子对应",
                planHash,
                sourceScope,
                runBudget: budget,
              }),
            },
          },
        ]),
      ).toThrowError(
        expect.objectContaining({ name: "ArtifactEventInvariantError" }),
      );
      expect(store.readProjection(runId).lastEventSequence).toBe(2);
    } finally {
      store.close();
    }
  });
});

async function createEvidenceReadyRun(options: {
  /** 是否把成功来源读取继续登记为 Evidence 与 Claim。 */
  readonly recordEvidenceAndClaim?: boolean;
  /** Scripted Model 尝试选择的 Claim identities；测试可借此模拟伪造引用。 */
  readonly proposalClaimIds?: readonly string[];
} = {}): Promise<{
  /** 当前测试仍持有、可继续提出 draft 的 Runtime。 */
  readonly runtime: ResearchAgentRuntime;
  /** 完成计划审批的 durable Run identity。 */
  readonly runId: string;
  /** 私有 Journal、Projection 与 CAS 所在的 Runtime Home。 */
  readonly runtimeHome: string;
  /** 用户可发布 Markdown 的受控临时目录。 */
  readonly outputDirectory: string;
}> {
  const runtimeHome = await createTemporaryDirectory("artifact-runtime-");
  const sourceRoot = await createTemporaryDirectory("artifact-source-");
  const outputDirectory = await createTemporaryDirectory("artifact-output-");
  await writeFile(
    join(sourceRoot, "source.md"),
    "title\nRun Journal 是 canonical history。\nProjection 可从 Journal 重建。\n",
    "utf8",
  );
  const ids = createIds();
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    ids,
    model: new ScriptedModel(
      [
        {
          title: "从来源建立可发布学习工件",
          objectives: ["验证 Evidence Gate"],
          steps: [{ id: "step-001", description: "读取 source.md" }],
        },
      ],
      [
        {
          title: "Journal 的可恢复性",
          summary: "这个 Learning Artifact 只渲染已登记 Claim 的结构化 Evidence 引用。",
          claimIds: options.proposalClaimIds ?? ["claim-event-007"],
        },
      ],
    ),
  });
  const waiting = await runtime.createRun({
    question: "为什么 Journal 可以驱动可恢复状态？",
    sourceScope: {
      roots: [sourceRoot],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 4_096,
      maxTotalBytes: 4_096,
    },
    runBudget: runBudget(),
  });
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试夹具要求等待计划审批");
  }
  await runtime.approvePlan({
    runId: waiting.runId,
    bindingHash: waiting.state.approvalBinding.bindingHash,
  });
  const read = await runtime.readSource({
    runId: waiting.runId,
    request: {
      rootIndex: 0,
      relativePath: "source.md",
      startLine: 2,
      endLine: 3,
    },
  });
  if (read.state.type !== "researching") {
    throw new Error("测试夹具要求成功来源读取后继续 researching");
  }
  const observation = read.state.sourceReadObservations[0];
  if (observation?.status !== "succeeded") {
    throw new Error("测试夹具要求成功来源读取 observation");
  }
  if (options.recordEvidenceAndClaim !== false) {
    const evidenced = await runtime.recordEvidence({
      runId: waiting.runId,
      observationId: observation.observationId,
    });
    if (evidenced.state.type !== "researching") {
      throw new Error("测试夹具要求登记 Evidence 后继续 researching");
    }
    const evidence = evidenced.state.evidenceRecords[0];
    if (evidence === undefined) {
      throw new Error("测试夹具要求一个 Evidence Record");
    }
    await runtime.recordClaim({
      runId: waiting.runId,
      text: "Run Journal 是 canonical history。",
      evidenceIds: [evidence.evidenceId],
    });
  }
  return { runtime, runId: waiting.runId, runtimeHome, outputDirectory };
}

function runBudget(): RunBudget {
  return {
    version: "budget-v1",
    maxModelTurns: 4,
    maxToolCalls: 4,
    maxDistinctSources: 2,
    maxSourceBytes: 4_096,
    maxWallTimeMs: 60_000,
  };
}

function createIds(): IdGenerator {
  let event = 0;
  return {
    nextRunId: () => "run-artifact-001",
    nextEventId: () => `event-${String(++event).padStart(3, "0")}`,
    nextApprovalId: () => "approval-plan-001",
    nextToolCallId: () => "tool-call-001",
    nextObservationId: () => "observation-001",
  };
}

function createTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then((directory) => {
    temporaryDirectories.push(directory);
    return directory;
  });
}
