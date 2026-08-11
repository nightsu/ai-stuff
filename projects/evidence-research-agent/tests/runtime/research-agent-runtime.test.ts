import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  ResearchAgentRuntime,
  ScriptedModel,
  formatRunTrace,
} from "../../src/index.js";
import type { RunProjection } from "../../src/index.js";

const runtimeHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    runtimeHomes.splice(0).map((runtimeHome) =>
      rm(runtimeHome, { force: true, recursive: true }),
    ),
  );
});

describe("ResearchAgentRuntime planning slice", () => {
  it("persists a proposed plan and rebuilds the same approval-wait state", async () => {
    const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-"));
    runtimeHomes.push(runtimeHome);

    const eventIds = ["event-001", "event-002", "event-003"];
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: new ScriptedModel([
        {
          title: "研究追加式 Run Journal",
          objectives: ["区分 canonical history 与 derived state"],
          steps: [
            {
              id: "step-001",
              description: "定位 Journal 与 Projection 的不变量",
            },
          ],
        },
      ]),
      clock: {
        now: () => "2026-08-12T08:00:00.000Z",
      },
      ids: {
        nextRunId: () => "run-001",
        nextApprovalId: () => {
          throw new Error("planning slice 不得生成审批 ID");
        },
        nextEventId: () => {
          const eventId = eventIds.shift();
          if (eventId === undefined) {
            throw new Error("测试事件 ID 已耗尽");
          }
          return eventId;
        },
      },
    });

    const runBudget = {
      version: "budget-v1",
      maxModelTurns: 8,
      maxToolCalls: 24,
      maxDistinctSources: 12,
      maxSourceBytes: 2_000_000,
      maxWallTimeMs: 300_000,
    } as const;
    const created = await runtime.createRun({
      question: "追加式 Run Journal 如何驱动派生状态投影？",
      sourceScope: {
        roots: [runtimeHome],
        exclusions: ["**/node_modules/**"],
        allowedExtensions: [".md", ".ts"],
        maxFileBytes: 256_000,
        maxTotalBytes: 2_000_000,
      },
      runBudget,
    });

    expect(created.runId).toBe("run-001");
    expect(created.runBudget).toEqual(runBudget);
    expect(created.state.type).toBe("waiting_plan_approval");
    if (created.state.type !== "waiting_plan_approval") {
      throw new Error("测试要求 Run 等待计划审批");
    }
    expect(created.state.approvalBinding.questionHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(created.state.approvalBinding.planHash).toBe(
      created.state.planArtifact.sha256,
    );
    expect(created.state.approvalBinding.sourceScopeHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(created.state.approvalBinding.budgetVersion).toBe("budget-v1");
    expect(created.state.approvalBinding.budgetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.state.approvalBinding.bindingHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(created.lastEventSequence).toBe(3);
    runtime.close();

    const database = new Database(join(runtimeHome, "runtime.sqlite"));
    const cachedJson = database
      .prepare(
        "SELECT projection_json FROM run_projections WHERE run_id = ?",
      )
      .pluck()
      .get("run-001");
    if (typeof cachedJson !== "string") {
      throw new Error("测试要求 SQLite 中存在 Projection cache");
    }
    const cachedProjection = JSON.parse(cachedJson) as RunProjection;
    if (cachedProjection.state.type !== "waiting_plan_approval") {
      throw new Error("测试要求缓存处于等待计划审批状态");
    }
    database
      .prepare(
        "UPDATE run_projections SET projection_json = ? WHERE run_id = ?",
      )
      .run(
        JSON.stringify({
          ...cachedProjection,
          state: {
            ...cachedProjection.state,
            approvalBinding: {
              ...cachedProjection.state.approvalBinding,
              bindingHash:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
          },
        }),
        "run-001",
      );
    database.close();

    const reopened = ResearchAgentRuntime.open({
      runtimeHome,
      model: new ScriptedModel([]),
    });
    const inspected = await reopened.inspectRun({ runId: "run-001" });
    expect(inspected).toEqual(created);

    const trace = await reopened.traceRun({ runId: "run-001" });
    expect(trace.events.map((event) => event.type)).toEqual([
      "run_created",
      "planning_started",
      "plan_proposed",
    ]);
    expect(formatRunTrace(trace, "human")).toContain(
      "#3 plan_proposed → waiting_plan_approval",
    );
    expect(JSON.parse(formatRunTrace(trace, "json"))).toEqual(trace);

    const rebuilt = await reopened.rebuildRunProjection({ runId: "run-001" });
    expect(rebuilt).toEqual(inspected);
    reopened.close();
  });

  it.each([
    ["malformed JSON", "{"],
    ["schema-invalid JSON", JSON.stringify({ runId: "run-001" })],
  ])("falls back to Journal replay for %s cache", async (_name, cacheJson) => {
    const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cache-"));
    runtimeHomes.push(runtimeHome);
    const created = await createCachedRun(runtimeHome);
    overwriteProjectionCache(runtimeHome, cacheJson);

    const reopened = ResearchAgentRuntime.open({
      runtimeHome,
      model: new ScriptedModel([]),
    });
    await expect(reopened.inspectRun({ runId: "run-001" })).resolves.toEqual(
      created,
    );
    reopened.close();
  });
});

async function createCachedRun(runtimeHome: string): Promise<RunProjection> {
  const eventIds = ["event-001", "event-002", "event-003"];
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    model: new ScriptedModel([
      {
        title: "验证 Projection cache 降级",
        objectives: ["从 canonical Journal 恢复"],
        steps: [{ id: "step-001", description: "验证缓存损坏不会阻断回放" }],
      },
    ]),
    clock: { now: () => "2026-08-12T08:00:00.000Z" },
    ids: {
      nextRunId: () => "run-001",
      nextApprovalId: () => {
        throw new Error("planning slice 不得生成审批 ID");
      },
      nextEventId: () => {
        const eventId = eventIds.shift();
        if (eventId === undefined) {
          throw new Error("测试事件 ID 已耗尽");
        }
        return eventId;
      },
    },
  });
  try {
    return await runtime.createRun({
      question: "Projection cache 损坏时如何恢复？",
      sourceScope: {
        roots: [runtimeHome],
        exclusions: ["**/.git/**"],
        allowedExtensions: [".md"],
        maxFileBytes: 256_000,
        maxTotalBytes: 2_000_000,
      },
      runBudget: {
        version: "budget-v1",
        maxModelTurns: 8,
        maxToolCalls: 24,
        maxDistinctSources: 12,
        maxSourceBytes: 2_000_000,
        maxWallTimeMs: 300_000,
      },
    });
  } finally {
    runtime.close();
  }
}

function overwriteProjectionCache(runtimeHome: string, cacheJson: string): void {
  const database = new Database(join(runtimeHome, "runtime.sqlite"));
  try {
    database
      .prepare(
        "UPDATE run_projections SET projection_json = ? WHERE run_id = ?",
      )
      .run(cacheJson, "run-001");
  } finally {
    database.close();
  }
}
