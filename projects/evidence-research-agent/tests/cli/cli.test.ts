import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli, type CliIo } from "../../src/cli.js";
import type { RunProjection } from "../../src/index.js";

const runtimeHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    runtimeHomes.splice(0).map((runtimeHome) =>
      rm(runtimeHome, { force: true, recursive: true }),
    ),
  );
});

it("creates, inspects, approves, and traces one Run through process-like CLI calls", async () => {
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
        runtimeHome,
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

  const approvalArgs = [
    "approve-plan",
    "--runtime-home",
    runtimeHome,
    "--run-id",
    created.runId,
    "--binding-hash",
    created.state.approvalBinding.bindingHash,
    "--json",
  ] as const;
  expect(await runCli(approvalArgs, io)).toBe(0);
  const approved = JSON.parse(output.pop() ?? "null") as RunProjection;
  expect(approved).toMatchObject({
    runId: created.runId,
    state: {
      type: "researching",
      approvalReceipt: {
        approvedBy: "user-command",
        bindingHash: created.state.approvalBinding.bindingHash,
      },
    },
    lastEventSequence: 4,
  });

  expect(await runCli(approvalArgs, io)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toEqual(approved);
  expect(approved.lastEventSequence).toBe(4);

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
  expect(output.pop()).toContain("#4 plan_approved → researching");
  expect(errorOutput).toEqual([]);
});

it("rejects missing, malformed, environment, and unknown approval authority safely", async () => {
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
        "为什么计划审批必须是独立用户命令？",
        "--source-root",
        runtimeHome,
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  const waiting = JSON.parse(output.pop() ?? "null") as RunProjection;
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试要求 CLI 创建等待计划审批的 Run");
  }
  const bindingHash = waiting.state.approvalBinding.bindingHash;
  const originalEnvironmentApproval =
    process.env.EVIDENCE_RESEARCH_AGENT_PLAN_APPROVAL;
  process.env.EVIDENCE_RESEARCH_AGENT_PLAN_APPROVAL = bindingHash;

  try {
    expect(
      await runCli(
        [
          "approve-plan",
          "--run-id",
          waiting.runId,
          "--binding-hash",
          bindingHash,
        ],
        io,
      ),
    ).toBe(1);
    expect(errorOutput.at(-1)).toContain("--runtime-home");

    expect(
      await runCli(
        [
          "approve-plan",
          "--runtime-home",
          runtimeHome,
          "--run-id",
          waiting.runId,
        ],
        io,
      ),
    ).toBe(1);
    expect(errorOutput.at(-1)).toContain("--binding-hash");

    expect(
      await runCli(
        [
          "approve-plan",
          "--runtime-home",
          runtimeHome,
          "--run-id",
          waiting.runId,
          "--binding-hash",
          "malformed-secret-binding",
        ],
        io,
      ),
    ).toBe(1);

    const untrustedPayload = "secret-model-authored-receipt";
    expect(
      await runCli(
        [
          "approve-plan",
          "--runtime-home",
          runtimeHome,
          "--run-id",
          waiting.runId,
          "--binding-hash",
          bindingHash,
          "--approval-receipt",
          untrustedPayload,
        ],
        io,
      ),
    ).toBe(1);
    expect(errorOutput.join("\n")).not.toContain(bindingHash);
    expect(errorOutput.join("\n")).not.toContain("malformed-secret-binding");
    expect(errorOutput.join("\n")).not.toContain(untrustedPayload);
  } finally {
    if (originalEnvironmentApproval === undefined) {
      delete process.env.EVIDENCE_RESEARCH_AGENT_PLAN_APPROVAL;
    } else {
      process.env.EVIDENCE_RESEARCH_AGENT_PLAN_APPROVAL =
        originalEnvironmentApproval;
    }
  }

  expect(
    await runCli(
      [
        "inspect",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        waiting.runId,
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    runId: waiting.runId,
    state: { type: "waiting_plan_approval" },
    lastEventSequence: 3,
  });
});

it("rejects an approval-only option on run before creating durable state", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  runtimeHomes.push(runtimeHome);
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };
  const secretQuestion = "secret question must not enter a CLI error";
  const secretBindingHash = "a".repeat(64);

  expect(
    await runCli(
      [
        "run",
        "--runtime-home",
        runtimeHome,
        "--question",
        secretQuestion,
        "--source-root",
        runtimeHome,
        "--binding-hash",
        secretBindingHash,
        "--json",
      ],
      io,
    ),
  ).toBe(1);
  expect(output).toEqual([]);
  expectJsonError(errorOutput, "CLI_USAGE_ERROR", "命令参数无效");
  expect(errorOutput.join("\n")).not.toContain(secretQuestion);
  expect(errorOutput.join("\n")).not.toContain(secretBindingHash);
  await expect(readdir(runtimeHome)).resolves.toEqual([]);
});

it("rejects a run-only option on approve-plan without appending approval", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  runtimeHomes.push(runtimeHome);
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };
  const waiting = await createWaitingRunViaCli(runtimeHome, output, io);
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试要求 CLI 创建等待计划审批的 Run");
  }
  output.length = 0;
  const secretQuestion = "secret injected approval question";
  const bindingHash = waiting.state.approvalBinding.bindingHash;

  expect(
    await runCli(
      [
        "approve-plan",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        waiting.runId,
        "--binding-hash",
        bindingHash,
        "--question",
        secretQuestion,
        "--json",
      ],
      io,
    ),
  ).toBe(1);
  expect(output).toEqual([]);
  expectJsonError(errorOutput, "CLI_USAGE_ERROR", "命令参数无效");
  expect(errorOutput.join("\n")).not.toContain(secretQuestion);
  expect(errorOutput.join("\n")).not.toContain(bindingHash);

  errorOutput.length = 0;
  expect(
    await runCli(
      [
        "trace",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        waiting.runId,
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    finalState: "waiting_plan_approval",
    events: [
      { type: "run_created" },
      { type: "planning_started" },
      { type: "plan_proposed" },
    ],
  });
  expect(errorOutput).toEqual([]);
});

it.each([
  ["inspect", ["--binding-hash", "b".repeat(64)]],
  ["trace", ["--question", "secret cross-command question"]],
  ["rebuild", []],
  ["inspect", ["unexpected-positional"]],
] as const)(
  "fails closed for isolated or unknown command invocation: %s %j",
  async (command, extraArgs) => {
    const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
    runtimeHomes.push(runtimeHome);
    const output: string[] = [];
    const errorOutput: string[] = [];
    const io = {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errorOutput.push(line),
    };
    const waiting = await createWaitingRunViaCli(runtimeHome, output, io);
    output.length = 0;

    expect(
      await runCli(
        [
          command,
          "--runtime-home",
          runtimeHome,
          "--run-id",
          waiting.runId,
          ...extraArgs,
          "--json",
        ],
        io,
      ),
    ).toBe(1);
    expect(output).toEqual([]);
    expectJsonError(errorOutput, "CLI_USAGE_ERROR", "命令参数无效");
    expect(errorOutput.join("\n")).not.toContain(waiting.runId);
    for (const extraArg of extraArgs) {
      expect(errorOutput.join("\n")).not.toContain(extraArg);
    }
  },
);

it("writes a stable JSON envelope for a rejected approval command", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  runtimeHomes.push(runtimeHome);
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };
  const waiting = await createWaitingRunViaCli(runtimeHome, output, io);
  output.length = 0;
  const malformedBinding = "malformed-secret-binding";

  expect(
    await runCli(
      [
        "approve-plan",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        waiting.runId,
        "--binding-hash",
        malformedBinding,
        "--json",
      ],
      io,
    ),
  ).toBe(1);
  expect(output).toEqual([]);
  expectJsonError(
    errorOutput,
    "PLAN_APPROVAL_REJECTED",
    "计划审批未被接受",
  );
  expect(errorOutput.join("\n")).not.toContain(malformedBinding);
});

async function createWaitingRunViaCli(
  runtimeHome: string,
  output: string[],
  io: CliIo,
): Promise<RunProjection> {
  expect(
    await runCli(
      [
        "run",
        "--runtime-home",
        runtimeHome,
        "--question",
        "验证 CLI 子命令参数隔离",
        "--source-root",
        runtimeHome,
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  return JSON.parse(output.pop() ?? "null") as RunProjection;
}

function expectJsonError(
  errorOutput: string[],
  code: string,
  message: string,
): void {
  expect(errorOutput).toHaveLength(1);
  expect(JSON.parse(errorOutput[0] ?? "null")).toEqual({
    error: { code, message },
  });
}
