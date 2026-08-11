import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ResearchAgentRuntime,
  ScriptedModel,
  formatRunTrace,
} from "../../src/index.js";

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
        nextEventId: () => {
          const eventId = eventIds.shift();
          if (eventId === undefined) {
            throw new Error("测试事件 ID 已耗尽");
          }
          return eventId;
        },
      },
    });

    const created = await runtime.createRun({
      question: "追加式 Run Journal 如何驱动派生状态投影？",
      sourceScope: {
        roots: ["/tmp/agent-learning-sources"],
        exclusions: ["**/node_modules/**"],
        allowedExtensions: [".md", ".ts"],
        maxFileBytes: 256_000,
        maxTotalBytes: 2_000_000,
      },
    });

    expect(created.runId).toBe("run-001");
    expect(created.state.type).toBe("waiting_plan_approval");
    expect(created.lastEventSequence).toBe(3);
    runtime.close();

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
});
