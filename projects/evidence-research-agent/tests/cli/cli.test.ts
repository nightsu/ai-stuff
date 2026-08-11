import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import type { RunProjection } from "../../src/index.js";

const runtimeHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    runtimeHomes.splice(0).map((runtimeHome) =>
      rm(runtimeHome, { force: true, recursive: true }),
    ),
  );
});

it("creates, inspects, and traces one Run through the thin CLI adapter", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  runtimeHomes.push(runtimeHome);
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };

  expect(
    await runCli(
      [
        "run",
        "--runtime-home",
        runtimeHome,
        "--question",
        "Run Journal 和 Projection 有什么区别？",
        "--source-root",
        "/tmp/agent-learning-sources",
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  const created = JSON.parse(output.pop() ?? "null") as RunProjection;
  expect(created.state.type).toBe("waiting_plan_approval");
  expect(created.runBudget).toEqual({
    version: "budget-v1",
    maxModelTurns: 12,
    maxToolCalls: 40,
    maxDistinctSources: 24,
    maxSourceBytes: 5_000_000,
    maxWallTimeMs: 300_000,
  });
  if (created.state.type !== "waiting_plan_approval") {
    throw new Error("测试要求 CLI 创建等待计划审批的 Run");
  }
  expect(created.state.approvalBinding).toMatchObject({
    questionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    planHash: created.state.planArtifact.sha256,
    sourceScopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    budgetVersion: "budget-v1",
    budgetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });

  expect(
    await runCli(
      [
        "inspect",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        created.runId,
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    runId: created.runId,
    state: { type: "waiting_plan_approval" },
  });

  expect(
    await runCli(
      [
        "trace",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        created.runId,
      ],
      io,
    ),
  ).toBe(0);
  expect(output.pop()).toContain("#3 plan_proposed → waiting_plan_approval");
  expect(errorOutput).toEqual([]);
});
