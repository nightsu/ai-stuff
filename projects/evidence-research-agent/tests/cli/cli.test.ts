import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli, type CliIo } from "../../src/cli.js";
import {
  ResearchAgentRuntime,
  ScriptedEvaluator,
  ScriptedModel,
} from "../../src/index.js";
import type {
  EvaluatorPort,
  ModelPort,
  ModelView,
  RunProjection,
} from "../../src/index.js";

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

  expect(
    await runCli(
      [
        "operation",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        created.runId,
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toEqual({});
  expect(errorOutput).toEqual([]);
});

it("pauses, resumes, and cancels a Run through isolated CLI commands", async () => {
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
  await runCli([
    "approve-plan",
    "--runtime-home",
    runtimeHome,
    "--run-id",
    waiting.runId,
    "--binding-hash",
    waiting.state.approvalBinding.bindingHash,
    "--json",
  ], io);
  output.length = 0;

  expect(await runCli([
    "pause",
    "--runtime-home",
    runtimeHome,
    "--run-id",
    waiting.runId,
    "--json",
  ], io)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    state: { type: "user_paused", suspendedState: { type: "researching" } },
  });

  expect(await runCli([
    "resume",
    "--runtime-home",
    runtimeHome,
    "--run-id",
    waiting.runId,
    "--json",
  ], io)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    state: { type: "researching" },
  });

  expect(await runCli([
    "cancel",
    "--runtime-home",
    runtimeHome,
    "--run-id",
    waiting.runId,
    "--json",
  ], io)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    state: { type: "cancelled", cancelledState: { type: "researching" } },
  });
  expect(errorOutput).toEqual([]);
});

it("extends an exhausted Run Budget through the CLI", async () => {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };
  // CLI 默认预算需要真实耗尽事件才能扩展；这里通过一个极小 tool-call budget 的 Run
  // 验证命令参数到 durable receipt 的完整路径，而不是只验证 parser 接受 option。
  const exhaustedRuntimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  runtimeHomes.push(exhaustedRuntimeHome);
  const exhaustedRuntime = ResearchAgentRuntime.open({
    runtimeHome: exhaustedRuntimeHome,
    model: new ScriptedModel([
      { title: "预算测试", objectives: ["预算测试"], steps: [{ id: "step", description: "step" }] },
    ], [], [{
      text: "一次工具调用后耗尽。",
      evidenceGaps: [],
      finishReason: "tool_calls",
      toolIntents: [
        { intentId: "not-last", name: "complete_research", input: { unresolvedQuestions: [] } },
        { intentId: "pending", name: "complete_research", input: { unresolvedQuestions: [] } },
      ],
    }]),
  });
  let exhausted: RunProjection;
  try {
    const created = await exhaustedRuntime.createRun({
      question: "CLI 如何批准新预算？",
      sourceScope: {
        roots: [exhaustedRuntimeHome],
        exclusions: [],
        allowedExtensions: [".md"],
        maxFileBytes: 1_000,
        maxTotalBytes: 10_000,
      },
      runBudget: {
        version: "budget-v1",
        maxModelTurns: 12,
        maxToolCalls: 1,
        maxDistinctSources: 24,
        maxSourceBytes: 5_000_000,
        maxWallTimeMs: 300_000,
      },
    });
    if (created.state.type !== "waiting_plan_approval") throw new Error("测试要求等待审批");
    await exhaustedRuntime.approvePlan({
      runId: created.runId,
      bindingHash: created.state.approvalBinding.bindingHash,
    });
    exhausted = await exhaustedRuntime.advanceResearch({ runId: created.runId });
  } finally {
    exhaustedRuntime.close();
  }
  expect(exhausted.state.type).toBe("budget_exhausted");

  expect(await runCli([
    "extend-budget",
    "--runtime-home",
    exhaustedRuntimeHome,
    "--run-id",
    exhausted.runId,
    "--version",
    "budget-v2",
    "--max-model-turns",
    String(exhausted.runBudget.maxModelTurns),
    "--max-tool-calls",
    "2",
    "--max-distinct-sources",
    String(exhausted.runBudget.maxDistinctSources),
    "--max-source-bytes",
    String(exhausted.runBudget.maxSourceBytes),
    "--max-wall-time-ms",
    String(exhausted.runBudget.maxWallTimeMs),
    "--json",
  ], io)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    runBudget: { version: "budget-v2", maxToolCalls: 2 },
    runBudgetApprovalReceipts: [{ kind: "run_budget_extension" }],
    state: { type: "researching", pendingToolIntents: [{ intentId: "pending" }] },
  });
  expect(errorOutput).toEqual([]);
});

it("reconciles a durable Publication Effect through the CLI", async () => {
  const fixture = await createCliReadyPublicationRun("reconcile.md");
  const interrupted = ResearchAgentRuntime.open({
    runtimeHome: fixture.runtimeHome,
    outputRoot: fixture.outputRoot,
    model: new ScriptedModel([]),
    ids: cliPublicationIds(100),
    clock: { now: () => "2026-08-13T03:31:00.000Z" },
    publicationEffectHooks: {
      afterAtomicPublish: () => {
        throw new Error("simulated crash after atomic publication");
      },
    },
  });
  await expect(interrupted.publishLearningArtifact({
    runId: fixture.runId,
  })).rejects.toThrow(/Learning Artifact/);
  await expect(interrupted.inspectRun({ runId: fixture.runId })).resolves
    .toMatchObject({ state: { type: "publication_executing" } });
  interrupted.close();

  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  };

  expect(await runCli([
    "reconcile",
    "--runtime-home",
    fixture.runtimeHome,
    "--output-root",
    fixture.outputRoot,
    "--run-id",
    fixture.runId,
    "--json",
  ], io)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    state: {
      type: "completed",
      publicationEffect: { status: "succeeded", settlement: "reconciled" },
    },
  });
  await expect(readFile(fixture.targetPath, "utf8")).resolves.toContain(
    "Run Journal 是 canonical history。",
  );
  expect(errors).toEqual([]);
});

it("publishes an approved Learning Artifact through an isolated CLI command", async () => {
  const fixture = await createCliReadyPublicationRun("graduation.md");

  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };
  expect(await runCli([
    "publish",
    "--runtime-home",
    fixture.runtimeHome,
    "--output-root",
    fixture.outputRoot,
    "--run-id",
    fixture.runId,
    "--json",
  ], io)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    state: {
      type: "completed",
      publicationEffect: { status: "succeeded" },
    },
  });
  expect(errorOutput).toEqual([]);
});

it("completes the graduation path through process-like CLI commands", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "evidence-agent-cli-source-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "evidence-agent-cli-output-"));
  runtimeHomes.push(runtimeHome, sourceRoot, outputRoot);
  await writeFile(
    join(sourceRoot, "journal.md"),
    "Run Journal 是 canonical history。\n",
    "utf8",
  );
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };
  const dependencies = {
    loadLiveModelPort: async () => graduationCliModel(),
  };

  expect(await runCli([
    "run",
    "--live-model",
    "--runtime-home",
    runtimeHome,
    "--question",
    "Run Journal 为什么可恢复？",
    "--source-root",
    sourceRoot,
    "--json",
  ], io, dependencies)).toBe(0);
  const waiting = JSON.parse(output.pop() ?? "null") as RunProjection;
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试要求等待计划审批");
  }
  expect(await runCli([
    "approve-plan",
    "--runtime-home",
    runtimeHome,
    "--run-id",
    waiting.runId,
    "--binding-hash",
    waiting.state.approvalBinding.bindingHash,
    "--json",
  ], io, dependencies)).toBe(0);
  output.pop();

  let research: RunProjection | undefined;
  for (let step = 0; step < 4; step += 1) {
    expect(await runCli([
      "advance",
      "--live-model",
      "--runtime-home",
      runtimeHome,
      "--run-id",
      waiting.runId,
      "--json",
    ], io, dependencies)).toBe(0);
    research = JSON.parse(output.pop() ?? "null") as RunProjection;
  }
  expect(research?.state.type).toBe("research_complete");

  const targetPath = join(outputRoot, "graduation.md");
  expect(await runCli([
    "propose-artifact",
    "--live-model",
    "--runtime-home",
    runtimeHome,
    "--output-root",
    outputRoot,
    "--run-id",
    waiting.runId,
    "--target-path",
    targetPath,
    "--json",
  ], io, dependencies)).toBe(0);
  const draft = JSON.parse(output.pop() ?? "null") as RunProjection;
  if (draft.state.type !== "waiting_publication_approval") {
    throw new Error("测试要求等待 publication approval");
  }

  expect(await runCli([
    "approve-publication",
    "--runtime-home",
    runtimeHome,
    "--output-root",
    outputRoot,
    "--run-id",
    waiting.runId,
    "--binding-hash",
    draft.state.publicationBinding.bindingHash,
    "--json",
  ], io, dependencies)).toBe(0);
  output.pop();
  expect(await runCli([
    "publish",
    "--runtime-home",
    runtimeHome,
    "--output-root",
    outputRoot,
    "--run-id",
    waiting.runId,
    "--json",
  ], io, dependencies)).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    state: { type: "completed" },
  });
  await expect(readFile(targetPath, "utf8")).resolves.toContain(
    "Run Journal 是 canonical history。",
  );
  expect(errorOutput).toEqual([]);
});

it("retries the exact failed Evaluator Review through the CLI without regenerating the proposal", async () => {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io: CliIo = {
    stdout: (line) => output.push(line),
    stderr: (line) => errorOutput.push(line),
  };
  let proposalCalls = 0;
  let reviewCalls = 0;
  const model = evaluatorResolutionCliModel({
    propose: () => {
      proposalCalls += 1;
    },
    review: async (request) => {
      reviewCalls += 1;
      if (reviewCalls === 1) throw new Error("private evaluator failure");
      return {
        verdicts: request.claims.map((claim) => ({
          claimId: claim.claimId,
          verdict: "uncertain" as const,
        })),
      };
    },
  });
  const fixture = await createCliEvaluatorReadyRun("retry-evaluator.md", model);
  const dependencies = {
    loadLiveModelPort: async () => model,
  };

  expect(await runCli([
    "propose-artifact",
    "--live-model",
    "--runtime-home",
    fixture.runtimeHome,
    "--output-root",
    fixture.outputRoot,
    "--run-id",
    fixture.runId,
    "--target-path",
    fixture.targetPath,
    "--json",
  ], io, dependencies)).toBe(1);
  expect(output).toEqual([]);
  expectJsonError(errorOutput, "CLI_COMMAND_FAILED", "命令执行失败");
  expect(proposalCalls).toBe(1);
  expect(reviewCalls).toBe(1);
  expect(await runCli([
    "inspect",
    "--runtime-home",
    fixture.runtimeHome,
    "--run-id",
    fixture.runId,
    "--json",
  ], io, dependencies)).toBe(0);
  const afterRetryProposalFailure = JSON.parse(
    output.pop() ?? "null",
  ) as RunProjection;
  expect(
    afterRetryProposalFailure.state.type,
    JSON.stringify(afterRetryProposalFailure.state, null, 2),
  ).toBe("waiting_evaluator_resolution");

  errorOutput.length = 0;
  const retryExitCode = await runCli([
    "retry-evaluator",
    "--live-model",
    "--runtime-home",
    fixture.runtimeHome,
    "--output-root",
    fixture.outputRoot,
    "--run-id",
    fixture.runId,
    "--json",
  ], io, dependencies);
  expect(retryExitCode, errorOutput.join("\n")).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    state: {
      type: "waiting_publication_approval",
      evaluation: {
        kind: "reviewed",
        review: { verdicts: [{ verdict: "uncertain" }] },
      },
    },
  });
  expect(proposalCalls).toBe(1);
  expect(reviewCalls).toBe(2);
  expect(errorOutput).toEqual([]);
});

it("records an explicit Evaluator skip through the CLI without fabricating a verdict", async () => {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io: CliIo = {
    stdout: (line) => output.push(line),
    stderr: (line) => errorOutput.push(line),
  };
  const model = evaluatorResolutionCliModel({
    review: async () => {
      throw new Error("private evaluator failure");
    },
  });
  const fixture = await createCliEvaluatorReadyRun("skip-evaluator.md", model);
  const dependencies = { loadLiveModelPort: async () => model };

  expect(await runCli([
    "propose-artifact",
    "--live-model",
    "--runtime-home",
    fixture.runtimeHome,
    "--output-root",
    fixture.outputRoot,
    "--run-id",
    fixture.runId,
    "--target-path",
    fixture.targetPath,
    "--json",
  ], io, dependencies)).toBe(1);
  expectJsonError(errorOutput, "CLI_COMMAND_FAILED", "命令执行失败");
  expect(await runCli([
    "inspect",
    "--runtime-home",
    fixture.runtimeHome,
    "--run-id",
    fixture.runId,
    "--json",
  ], io, dependencies)).toBe(0);
  const afterSkipProposalFailure = JSON.parse(
    output.pop() ?? "null",
  ) as RunProjection;
  expect(
    afterSkipProposalFailure.state.type,
    JSON.stringify(afterSkipProposalFailure.state, null, 2),
  ).toBe("waiting_evaluator_resolution");
  errorOutput.length = 0;

  const skipExitCode = await runCli([
    "skip-evaluator",
    "--runtime-home",
    fixture.runtimeHome,
    "--output-root",
    fixture.outputRoot,
    "--run-id",
    fixture.runId,
    "--json",
  ], io, dependencies);
  expect(skipExitCode, errorOutput.join("\n")).toBe(0);
  const skipped = JSON.parse(output.pop() ?? "null") as RunProjection;
  expect(skipped).toMatchObject({
    state: {
      type: "waiting_publication_approval",
      evaluation: { kind: "skipped" },
      publicationApprovalSummary: {
        advisoryWarnings: [{ kind: "evaluator_skipped" }],
      },
    },
  });
  expect(JSON.stringify(skipped)).not.toMatch(
    /"verdict":"(supported|partially_supported|unsupported|contradicted|uncertain)"/,
  );
  expect(errorOutput).toEqual([]);
});

it("fails safely when live-model environment is incomplete before opening Runtime Home", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  runtimeHomes.push(runtimeHome);
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };
  const environmentKeys = [
    "EVIDENCE_MODEL_PROVIDER",
    "EVIDENCE_MODEL_BASE_URL",
    "EVIDENCE_MODEL_API_KEY",
    "EVIDENCE_MODEL_NAME",
  ] as const;
  const original = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of environmentKeys) delete process.env[key];

  try {
    expect(await runCli([
      "run",
      "--live-model",
      "--runtime-home",
      runtimeHome,
      "--question",
      "真实模型如何生成计划？",
      "--source-root",
      runtimeHome,
      "--json",
    ], io)).toBe(1);
  } finally {
    for (const key of environmentKeys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  expect(output).toEqual([]);
  expectJsonError(errorOutput, "CLI_COMMAND_FAILED", "命令执行失败");
  await expect(readdir(runtimeHome)).resolves.toEqual([]);
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
  ["operation", ["--binding-hash", "b".repeat(64)]],
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

function cliPublicationIds(startAt = 0) {
  let event = startAt;
  let toolCall = startAt;
  let observation = startAt;
  return {
    nextRunId: () => "run-cli-publication",
    nextApprovalId: () => "approval-cli-publication",
    nextEventId: () => `event-${String(++event).padStart(3, "0")}`,
    nextToolCallId: () => `tool-call-${String(++toolCall).padStart(3, "0")}`,
    nextObservationId: () =>
      `observation-${String(++observation).padStart(3, "0")}`,
  };
}

async function createCliReadyPublicationRun(targetName: string) {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "evidence-agent-cli-source-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "evidence-agent-cli-output-"));
  runtimeHomes.push(runtimeHome, sourceRoot, outputRoot);
  await writeFile(
    join(sourceRoot, "source.md"),
    "Run Journal 是 canonical history。\n",
    "utf8",
  );
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    outputRoot,
    model: new ScriptedModel(
      [{
        title: "CLI publication",
        objectives: ["形成可发布 Claim"],
        steps: [{ id: "step-1", description: "读取固定来源" }],
      }],
      [{
        title: "CLI graduation",
        summary: "CLI 必须通过 headless Runtime 完成写出。",
        claimIds: ["claim-event-007"],
      }],
    ),
    evaluator: new ScriptedEvaluator(),
    clock: { now: () => "2026-08-13T03:30:00.000Z" },
    ids: cliPublicationIds(),
  });
  const waiting = await runtime.createRun({
    question: "CLI 如何完成发布？",
    sourceScope: {
      roots: [sourceRoot],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 4_096,
      maxTotalBytes: 4_096,
    },
    runBudget: {
      version: "budget-v1",
      maxModelTurns: 4,
      maxToolCalls: 4,
      maxDistinctSources: 2,
      maxSourceBytes: 4_096,
      maxWallTimeMs: 60_000,
    },
  });
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试要求等待计划审批");
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
      startLine: 1,
      endLine: 1,
    },
  });
  if (read.state.type !== "researching") {
    throw new Error("测试要求来源读取后继续 researching");
  }
  const observation = read.state.sourceReadObservations[0];
  if (observation?.status !== "succeeded") {
    throw new Error("测试要求成功来源 observation");
  }
  const evidenced = await runtime.recordEvidence({
    runId: waiting.runId,
    observationId: observation.observationId,
  });
  if (evidenced.state.type !== "researching") {
    throw new Error("测试要求 Evidence 后继续 researching");
  }
  const evidence = evidenced.state.evidenceRecords[0];
  if (evidence === undefined) throw new Error("测试要求 Evidence Record");
  await runtime.recordClaim({
    runId: waiting.runId,
    kind: "source_fact",
    text: "Run Journal 是 canonical history。",
    evidenceIds: [evidence.evidenceId],
  });
  const targetPath = join(outputRoot, targetName);
  const draft = await runtime.proposeLearningArtifact({
    runId: waiting.runId,
    targetPath,
  });
  if (draft.state.type !== "waiting_publication_approval") {
    throw new Error("测试要求等待 publication approval");
  }
  await runtime.approvePublication({
    runId: waiting.runId,
    bindingHash: draft.state.publicationBinding.bindingHash,
  });
  runtime.close();
  return {
    runtimeHome,
    outputRoot,
    runId: waiting.runId,
    targetPath,
  };
}

async function createCliEvaluatorReadyRun(
  targetName: string,
  model: ModelPort & EvaluatorPort,
) {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "evidence-agent-cli-source-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "evidence-agent-cli-output-"));
  runtimeHomes.push(runtimeHome, sourceRoot, outputRoot);
  await writeFile(
    join(sourceRoot, "source.md"),
    "Run Journal 是 canonical history。\n",
    "utf8",
  );
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    outputRoot,
    model,
    ids: cliPublicationIds(),
  });
  const waiting = await runtime.createRun({
    question: "CLI 如何处理 Evaluator Resolution？",
    sourceScope: {
      roots: [sourceRoot],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 4_096,
      maxTotalBytes: 4_096,
    },
    runBudget: {
      version: "budget-v1",
      maxModelTurns: 4,
      maxToolCalls: 4,
      maxDistinctSources: 2,
      maxSourceBytes: 4_096,
      maxWallTimeMs: 60_000,
    },
  });
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试要求等待计划审批");
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
      startLine: 1,
      endLine: 1,
    },
  });
  if (read.state.type !== "researching") {
    throw new Error("测试要求来源读取后继续 researching");
  }
  const observation = read.state.sourceReadObservations[0];
  if (observation?.status !== "succeeded") {
    throw new Error("测试要求成功来源 observation");
  }
  const evidenced = await runtime.recordEvidence({
    runId: waiting.runId,
    observationId: observation.observationId,
  });
  if (evidenced.state.type !== "researching") {
    throw new Error("测试要求 Evidence 后继续 researching");
  }
  const evidence = evidenced.state.evidenceRecords[0];
  if (evidence === undefined) throw new Error("测试要求 Evidence Record");
  await runtime.recordClaim({
    runId: waiting.runId,
    kind: "source_fact",
    text: "Run Journal 是 canonical history。",
    evidenceIds: [evidence.evidenceId],
  });
  runtime.close();
  return {
    runtimeHome,
    outputRoot,
    runId: waiting.runId,
    targetPath: join(outputRoot, targetName),
  };
}

function evaluatorResolutionCliModel(callbacks: {
  /** proposal generation 次数的测试观察点。 */
  readonly propose?: () => void;
  /** isolated evaluator review 的可替换测试边界。 */
  readonly review?: EvaluatorPort["reviewClaims"];
} = {}): ModelPort & EvaluatorPort {
  const experimentIdentity = {
    provider: "scripted-live",
    model: "evaluator-resolution-model",
    adapterVersion: "evaluator-resolution-adapter-v1",
    promptVersion: "evaluator-resolution-prompt-v1",
    toolSchemaVersion: "evaluator-resolution-tools-v1",
  } as const;
  return {
    experimentIdentity,
    identity: {
      provider: experimentIdentity.provider,
      model: experimentIdentity.model,
      promptVersion: "evaluator-resolution-review-v1",
    },
    proposePlan: async () => ({
      title: "验证 CLI Evaluator Resolution",
      objectives: ["从固定 Evidence 形成可审阅 Claim"],
      steps: [{ id: "step-1", description: "读取来源并形成 Claim" }],
    }),
    generateResearchTurn: async () => {
      throw new Error("显式 Evidence fixture 不执行 Research Loop");
    },
    proposeLearningArtifact: async (request) => {
      callbacks.propose?.();
      return {
        title: "CLI Evaluator Resolution",
        summary: "CLI 必须保留 exact evaluator input。",
        claimIds: [request.claims[0]?.claimId ?? "missing-claim"],
      };
    },
    reviewClaims: callbacks.review ?? (async (request) => ({
      verdicts: request.claims.map((claim) => ({
        claimId: claim.claimId,
        verdict: "supported" as const,
      })),
    })),
  };
}

function graduationCliModel(): ModelPort & EvaluatorPort {
  const experimentIdentity = {
    provider: "scripted-live",
    model: "graduation-model",
    adapterVersion: "graduation-adapter-v1",
    promptVersion: "graduation-prompt-v1",
    toolSchemaVersion: "graduation-tools-v1",
  } as const;
  return {
    experimentIdentity,
    identity: {
      provider: experimentIdentity.provider,
      model: experimentIdentity.model,
      promptVersion: "graduation-evaluator-v1",
    },
    proposePlan: async () => ({
      title: "验证 CLI graduation path",
      objectives: ["从固定来源形成可发布 Claim"],
      steps: [{ id: "step-1", description: "读取 journal.md 并形成 Evidence" }],
    }),
    generateResearchTurn: async (view: ModelView) => {
      const latest = view.recentObservations.at(-1);
      if (latest === undefined) {
        return graduationTurn("read", "read_source", {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        });
      }
      if (view.relevantEvidence.length === 0) {
        return graduationTurn("evidence", "record_evidence", {
          observationId: latest.observationId,
        });
      }
      if (!view.recentObservations.some((item) =>
        item.toolName === "propose_claim" && item.status === "succeeded"
      )) {
        return graduationTurn("claim", "propose_claim", {
          kind: "source_fact",
          text: "Run Journal 是 canonical history。",
          evidenceIds: [view.relevantEvidence[0]?.evidenceId],
        });
      }
      return graduationTurn("complete", "complete_research", {
        unresolvedQuestions: [],
      });
    },
    proposeLearningArtifact: async (request) => ({
      title: "CLI graduation",
      summary: "CLI 通过 headless Runtime 完成了可追溯发布。",
      claimIds: [request.claims[0]?.claimId ?? "missing-claim"],
    }),
    reviewClaims: async (request) => ({
      verdicts: request.claims.map((claim) => ({
        claimId: claim.claimId,
        verdict: "supported" as const,
      })),
    }),
  };
}

function graduationTurn(
  intentId: string,
  name: "read_source" | "record_evidence" | "propose_claim" | "complete_research",
  input: Record<string, unknown>,
) {
  return {
    text: `执行 ${name}`,
    evidenceGaps: [],
    finishReason: "tool_calls" as const,
    toolIntents: [{ intentId, name, input }],
  };
}
