import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ResearchAgentRuntime,
  ScriptedModel,
} from "../../src/index.js";
import type { RunBudget, RunProjection } from "../../src/index.js";
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

describe("ResearchAgentRuntime evidence gate", () => {
  it("derives an Evidence Record from a successful source observation and records a cited Claim", async () => {
    const fixture = await createApprovedReadRun();
    const runtime = openRuntime(fixture.runtimeHome);

    try {
      const read = await runtime.readSource({
        runId: fixture.runId,
        request: {
          rootIndex: 0,
          relativePath: "source.md",
          startLine: 2,
          endLine: 3,
        },
      });
      const observation = onlySucceededObservation(read);
      const evidenced = await runtime.recordEvidence({
        runId: fixture.runId,
        observationId: observation.observationId,
      });
      const evidence = onlyEvidenceRecord(evidenced);
      const claimed = await runtime.recordClaim({
        runId: fixture.runId,
        kind: "source_fact",
        text: "来源明确说明 Journal 是 canonical history。Projection 可由 Journal 重建。",
        evidenceIds: [evidence.evidenceId],
      });

      expect(evidence).toMatchObject({
        kind: "source_fact",
        observationId: observation.observationId,
        toolCallId: observation.toolCallId,
        sourceSnapshotId: observation.sourceSnapshot.snapshotId,
        startLine: 2,
        endLine: 3,
        excerptHash: observation.excerptHash,
      });
      expect(evidence.evidenceId).toMatch(/^evidence-/);
      expect(claimed.state).toMatchObject({
        type: "researching",
        claims: [
          {
            kind: "source_fact",
            text: "来源明确说明 Journal 是 canonical history。Projection 可由 Journal 重建。",
            evidenceIds: [evidence.evidenceId],
          },
        ],
      });
      const trace = await runtime.traceRun({ runId: fixture.runId });
      expect(trace.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "evidence_recorded" }),
          expect.objectContaining({ type: "claim_recorded" }),
        ]),
      );
    } finally {
      runtime.close();
    }
  });

  it("fails closed when evidence does not name one durable successful observation or a Claim cites an unknown Evidence ID", async () => {
    const fixture = await createApprovedReadRun();
    const runtime = openRuntime(fixture.runtimeHome);

    try {
      await expect(
        runtime.recordEvidence({
          runId: fixture.runId,
          observationId: "observation-not-durable",
        }),
      ).rejects.toThrow(/Evidence/);
      await expect(
        runtime.recordClaim({
          runId: fixture.runId,
          kind: "source_fact",
          text: "没有可验证引用的主张。",
          evidenceIds: ["evidence-not-durable"],
        }),
      ).rejects.toThrow(/Evidence/);

      const persisted = await runtime.inspectRun({ runId: fixture.runId });
      expect(persisted.lastEventSequence).toBe(4);
      expect(persisted.state).toMatchObject({
        type: "researching",
        evidenceRecords: [],
        claims: [],
      });
    } finally {
      runtime.close();
    }
  });

  it("requires an explicit source_fact classification and rejects pre-rendered citation text", async () => {
    const fixture = await createApprovedReadRun();
    const runtime = openRuntime(fixture.runtimeHome);

    try {
      const read = await runtime.readSource({
        runId: fixture.runId,
        request: {
          rootIndex: 0,
          relativePath: "source.md",
          startLine: 2,
          endLine: 3,
        },
      });
      const evidenceProjection = await runtime.recordEvidence({
        runId: fixture.runId,
        observationId: onlySucceededObservation(read).observationId,
      });
      const evidence = onlyEvidenceRecord(evidenceProjection);
      await expect(
        runtime.recordClaim({
          runId: fixture.runId,
          kind: "source_fact",
          text: "调用方不能预渲染 【Evidence: forged】。",
          evidenceIds: [evidence.evidenceId],
        }),
      ).rejects.toThrow(/Claim/);
      await expect(
        runtime.recordClaim({
          runId: fixture.runId,
          kind: "source_fact",
          text: "来源事实需要明确分类。",
          evidenceIds: [evidence.evidenceId],
        }),
      ).resolves.toMatchObject({
        state: { type: "researching", claims: [{ kind: "source_fact" }] },
      });
    } finally {
      runtime.close();
    }
  });

  it("rejects a directly supplied Evidence event whose snapshot linkage is self-consistently forged", async () => {
    const fixture = await createApprovedReadRun();
    const runtime = openRuntime(fixture.runtimeHome);

    try {
      const read = await runtime.readSource({
        runId: fixture.runId,
        request: {
          rootIndex: 0,
          relativePath: "source.md",
          startLine: 2,
          endLine: 3,
        },
      });
      const observation = onlySucceededObservation(read);
      await runtime.recordEvidence({
        runId: fixture.runId,
        observationId: observation.observationId,
      });
    } finally {
      runtime.close();
    }

    const store = new SqliteRunStore(fixture.runtimeHome);
    const events = structuredClone(store.readEvents(fixture.runId));
    store.close();
    const evidenceEvent = events.at(-1);
    if (evidenceEvent?.type !== "evidence_recorded") {
      throw new Error("测试夹具要求最后一个事件为 evidence_recorded");
    }
    events[events.length - 1] = {
      ...evidenceEvent,
      payload: {
        evidence: {
          ...evidenceEvent.payload.evidence,
          sourceSnapshotId: `source-sha256:${"f".repeat(64)}`,
        },
      },
    };

    expect(() => reduceRunEvents(events)).toThrow(IllegalRunEventError);
    expect(() => reduceRunEvents(events)).toThrow(
      /Evidence Record 未精确绑定成功来源 observation/,
    );
  });
});

async function createApprovedReadRun(): Promise<{
  /** 私有 SQLite 与 CAS 共同使用的临时 Runtime Home。 */
  readonly runtimeHome: string;
  /** 由 durable plan approval 得到的可读取 Run identity。 */
  readonly runId: string;
}> {
  const runtimeHome = await createTemporaryDirectory("evidence-gate-runtime-");
  const sourceRoot = await createTemporaryDirectory("evidence-gate-source-");
  await writeFile(
    join(sourceRoot, "source.md"),
    "标题\nJournal 是 canonical history。\nProjection 可由 Journal 重建。\n",
    "utf8",
  );
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    model: new ScriptedModel([
      {
        title: "记录一个可验证来源事实",
        objectives: ["从快照建立 Evidence Record"],
        steps: [{ id: "step-001", description: "读取 source.md" }],
      },
    ]),
  });
  try {
    const waiting = await runtime.createRun({
      question: "如何把来源事实变成可审计证据？",
      sourceScope: {
        roots: [sourceRoot],
        exclusions: [],
        allowedExtensions: [".md"],
        maxFileBytes: 4_096,
        maxTotalBytes: 4_096,
      },
      runBudget: defaultRunBudget(),
    });
    if (waiting.state.type !== "waiting_plan_approval") {
      throw new Error("测试夹具要求等待计划审批");
    }
    await runtime.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.state.approvalBinding.bindingHash,
    });
    return { runtimeHome, runId: waiting.runId };
  } finally {
    runtime.close();
  }
}

function openRuntime(runtimeHome: string): ResearchAgentRuntime {
  return ResearchAgentRuntime.open({
    runtimeHome,
    model: new ScriptedModel([]),
  });
}

function defaultRunBudget(): RunBudget {
  return {
    version: "budget-v1",
    maxModelTurns: 4,
    maxToolCalls: 4,
    maxDistinctSources: 2,
    maxSourceBytes: 4_096,
    maxWallTimeMs: 60_000,
  };
}

function onlySucceededObservation(projection: RunProjection) {
  if (projection.state.type !== "researching") {
    throw new Error("测试要求 researching Projection");
  }
  const observation = projection.state.sourceReadObservations[0];
  if (observation?.status !== "succeeded") {
    throw new Error("测试要求一个成功来源读取 observation");
  }
  return observation;
}

function onlyEvidenceRecord(projection: RunProjection) {
  if (projection.state.type !== "researching") {
    throw new Error("测试要求 researching Projection");
  }
  const evidence = projection.state.evidenceRecords[0];
  if (evidence === undefined) {
    throw new Error("测试要求一个 durable Evidence Record");
  }
  return evidence;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
