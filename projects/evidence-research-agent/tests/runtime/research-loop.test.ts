import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ModelViewTooLargeError,
  ResearchAgentRuntime,
  ScriptedModel,
} from "../../src/index.js";
import type {
  Clock,
  IdGenerator,
  OpenRuntimeOptions,
  RunBudget,
} from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ResearchAgentRuntime bounded Research Loop", () => {
  it("rebuilds a Model View across five Harness-dispatched Research Tools and completes explicitly", async () => {
    const runtimeHome = await createTemporaryDirectory("research-loop-runtime-");
    const sourceRoot = await createTemporaryDirectory("research-loop-source-");
    const outputRoot = await createTemporaryDirectory("research-loop-output-");
    await writeFile(
      join(sourceRoot, "journal.md"),
      "# Journal\nRun Journal 是 canonical history。\nProjection 可以从 Journal 重建。\n",
      "utf8",
    );
    const model = new ScriptedModel(
      [
        {
          title: "验证 Run Journal 的恢复边界",
          objectives: ["找到并引用 canonical history 的来源事实"],
          steps: [{ id: "step-001", description: "搜索、读取并登记来源事实" }],
        },
      ],
      [
        {
          title: "Run Journal 的可恢复性",
          summary: "研究循环已显式完成，并保留结构化 Evidence lineage。",
          claimIds: ["claim-event-012"],
        },
      ],
      [
        {
          text: "先定位相关来源。",
          evidenceGaps: ["canonical history 的原文位置"],
          finishReason: "tool_calls",
          toolIntents: [
            {
              intentId: "intent-search",
              name: "search_sources",
              input: { query: "canonical history", maxResults: 5 },
            },
          ],
        },
        {
          text: "读取命中的精确范围。",
          evidenceGaps: ["需要冻结命中来源"],
          finishReason: "tool_calls",
          toolIntents: [
            {
              intentId: "intent-read",
              name: "read_source",
              input: {
                rootIndex: 0,
                relativePath: "journal.md",
                startLine: 2,
                endLine: 3,
              },
            },
          ],
        },
        {
          text: "把成功读取登记为 Evidence。",
          evidenceGaps: ["需要建立可引用 identity"],
          finishReason: "tool_calls",
          toolIntents: [
            {
              intentId: "intent-evidence",
              name: "record_evidence",
              input: { observationId: "observation-002" },
            },
          ],
        },
        {
          text: "提出一个有 Evidence 支持的 Claim。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [
            {
              intentId: "intent-claim",
              name: "propose_claim",
              input: {
                kind: "source_fact",
                text: "Run Journal 是 canonical history。",
                evidenceIds: ["evidence-event-010"],
              },
            },
          ],
        },
        {
          text: "证据缺口已关闭。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [
            {
              intentId: "intent-complete",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            },
          ],
        },
      ],
    );
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
    });

    try {
      const waiting = await runtime.createRun({
        question: "为什么 Run Journal 能支持恢复？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 4_096,
          maxTotalBytes: 4_096,
        },
        runBudget: generousBudget(),
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试要求等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });

      const completed = await runtime.advanceResearch({
        runId: waiting.runId,
        steering: "优先确认 Journal 与 Projection 的恢复关系。",
      });

      expect(completed.state).toMatchObject({
        type: "research_complete",
        modelTurns: expect.arrayContaining([
          expect.objectContaining({ finishReason: "tool_calls" }),
        ]),
        researchToolObservations: [
          expect.objectContaining({ toolName: "search_sources", status: "succeeded" }),
          expect.objectContaining({ toolName: "read_source", status: "succeeded" }),
          expect.objectContaining({ toolName: "record_evidence", status: "succeeded" }),
          expect.objectContaining({ toolName: "propose_claim", status: "succeeded" }),
          expect.objectContaining({ toolName: "complete_research", status: "succeeded" }),
        ],
        completion: { unresolvedQuestions: [] },
        evidenceRecords: [expect.objectContaining({ evidenceId: "evidence-event-010" })],
        claims: [expect.objectContaining({ claimId: "claim-event-012" })],
      });
      expect(model.researchViews).toHaveLength(5);
      expect(model.researchViews[0]).toMatchObject({
        question: "为什么 Run Journal 能支持恢复？",
        approvedPlan: { title: "验证 Run Journal 的恢复边界" },
        latestSteering: "优先确认 Journal 与 Projection 的恢复关系。",
        remainingBudget: {
          modelTurns: 7,
          toolCalls: 8,
          distinctSources: 3,
          sourceBytes: 4_096,
        },
      });
      expect(model.researchViews[1]?.recentObservations[0]?.summary).toContain(
        "journal.md",
      );
      expect(model.researchViews[3]?.relevantEvidence[0]).toMatchObject({
        evidenceId: "evidence-event-010",
        excerpt: "Run Journal 是 canonical history。\nProjection 可以从 Journal 重建。",
      });
      expect(model.researchViews[4]).not.toHaveProperty("events");
      expect(model.researchViews[4]).not.toHaveProperty("messages");

      await expect(
        runtime.proposeLearningArtifact({
          runId: waiting.runId,
          targetPath: join(outputRoot, "journal-learning.md"),
        }),
      ).resolves.toMatchObject({ state: { type: "waiting_publication_approval" } });

      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.filter((event) => event.type === "model_turn_completed"))
        .toHaveLength(5);
      expect(trace.events.at(-2)?.type).toBe("research_completed");
    } finally {
      runtime.close();
    }
  });

  it("feeds invalid schema, denial, stale evidence, and ordinary tool failure back as observations", async () => {
    const fixture = await createApprovedLoopRun([
      turn("bad-search", "search_sources", { query: "canonical history", maxResults: 0 }),
      turn("denied-read", "read_source", {
        rootIndex: 0,
        relativePath: "../outside.md",
        startLine: 1,
        endLine: 1,
      }),
      turn("stale-evidence", "record_evidence", {
        observationId: "observation-missing",
      }),
      turn("missing-file", "read_source", {
        rootIndex: 0,
        relativePath: "missing.md",
        startLine: 1,
        endLine: 1,
      }),
      turn("complete", "complete_research", {
        unresolvedQuestions: ["未获得可登记来源"],
      }),
    ]);
    try {
      const completed = await fixture.runtime.advanceResearch({
        runId: fixture.runId,
      });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        researchToolObservations: [
          expect.objectContaining({ status: "invalid", code: "invalid_tool_schema" }),
          expect.objectContaining({ status: "denied", code: "path_escape" }),
          expect.objectContaining({ status: "failed", code: "stale_observation" }),
          expect.objectContaining({ status: "failed", code: "source_not_found" }),
          expect.objectContaining({ status: "succeeded", toolName: "complete_research" }),
        ],
      });
      expect(fixture.model.researchViews[1]?.recentObservations).toEqual([
        expect.objectContaining({ code: "invalid_tool_schema" }),
      ]);
      expect(fixture.model.researchViews[4]?.recentObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "path_escape" }),
          expect.objectContaining({ code: "stale_observation" }),
          expect.objectContaining({ code: "source_not_found" }),
        ]),
      );
    } finally {
      fixture.runtime.close();
    }
  });

  it.each([
    ["model_turns", { maxModelTurns: 2 }],
    ["tool_calls", { maxToolCalls: 1 }],
    ["distinct_sources", { maxDistinctSources: 1 }],
    ["source_bytes", { maxSourceBytes: 1 }],
  ] as const)("suspends as budget_exhausted when %s is depleted", async (dimension, limits) => {
    const turns =
      dimension === "model_turns"
        ? [turn("search", "search_sources", { query: "canonical", maxResults: 5 })]
        : dimension === "tool_calls"
          ? [
              {
                text: "同一 turn 提出两个 calls。",
                evidenceGaps: [],
                finishReason: "tool_calls" as const,
                toolIntents: [
                  { intentId: "first", name: "search_sources" as const, input: { query: "canonical", maxResults: 5 } },
                  { intentId: "second", name: "search_sources" as const, input: { query: "Projection", maxResults: 5 } },
                ],
              },
            ]
          : [
              turn("read-first", "read_source", {
                rootIndex: 0,
                relativePath: dimension === "source_bytes" ? "tiny.md" : "other.md",
                startLine: 1,
                endLine: 1,
              }),
            ];
    const fixture = await createApprovedLoopRun(turns, limits);
    try {
      const suspended = await fixture.runtime.advanceResearch({ runId: fixture.runId });
      expect(suspended.state).toMatchObject({
        type: "budget_exhausted",
        exhaustedDimension: dimension,
      });
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputRoot, "must-not-publish.md"),
        }),
      ).rejects.toThrow(/状态不能提出/);
    } finally {
      fixture.runtime.close();
    }
  });

  it("counts explicit source reads against the same Research Tool budget", async () => {
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 5 })],
      { maxToolCalls: 1 },
    );
    try {
      await fixture.runtime.readSource({
        runId: fixture.runId,
        request: {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        },
      });

      const suspended = await fixture.runtime.advanceResearch({ runId: fixture.runId });
      expect(suspended.state).toMatchObject({
        type: "budget_exhausted",
        exhaustedDimension: "tool_calls",
      });
      expect(fixture.model.researchViews).toEqual([]);
    } finally {
      fixture.runtime.close();
    }
  });

  it("does not persist a changed same-path source as a second distinct snapshot", async () => {
    const fixture = await createApprovedLoopRun(
      [turn("read-again", "read_source", {
        rootIndex: 0,
        relativePath: "journal.md",
        startLine: 1,
        endLine: 1,
      })],
      { maxDistinctSources: 1 },
    );
    try {
      await fixture.runtime.readSource({
        runId: fixture.runId,
        request: {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        },
      });
      await writeFile(
        join(fixture.sourceRoot, "journal.md"),
        "Run Projection 从 Journal 重建。\n",
        "utf8",
      );

      const suspended = await fixture.runtime.advanceResearch({ runId: fixture.runId });
      expect(suspended.state).toMatchObject({
        type: "budget_exhausted",
        exhaustedDimension: "distinct_sources",
        sourceReadObservations: [expect.objectContaining({ status: "succeeded" })],
      });
    } finally {
      fixture.runtime.close();
    }
  });

  it("returns a completion ordering mistake as an observation instead of crashing", async () => {
    const fixture = await createApprovedLoopRun([
      {
        text: "过早完成后仍提出搜索。",
        evidenceGaps: [],
        finishReason: "tool_calls",
        toolIntents: [
          {
            intentId: "complete-too-early",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          },
          {
            intentId: "search-after-complete",
            name: "search_sources",
            input: { query: "canonical", maxResults: 5 },
          },
        ],
      },
      turn("complete-finally", "complete_research", { unresolvedQuestions: [] }),
    ]);
    try {
      const completed = await fixture.runtime.advanceResearch({ runId: fixture.runId });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        researchToolObservations: [
          expect.objectContaining({
            toolName: "complete_research",
            status: "invalid",
            code: "completion_not_last",
          }),
          expect.objectContaining({ toolName: "search_sources", status: "succeeded" }),
          expect.objectContaining({ toolName: "complete_research", status: "succeeded" }),
        ],
      });
    } finally {
      fixture.runtime.close();
    }
  });

  it("stops explicitly when deterministic trimming cannot fit pinned Model View facts", async () => {
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 5 })],
      {},
      { maxModelViewBytes: 128 },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({
          runId: fixture.runId,
          steering: "这个 steering 必须始终 pin 在上下文里。",
        }),
      ).rejects.toBeInstanceOf(ModelViewTooLargeError);
      const persisted = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(persisted.state).toMatchObject({
        type: "researching",
        modelTurns: [],
        researchToolObservations: [],
      });
      expect(fixture.model.researchViews).toEqual([]);
    } finally {
      fixture.runtime.close();
    }
  });

  it("starts wall-time accounting at the first Research Loop turn rather than during approval wait", async () => {
    let clockCalls = 0;
    const clock: Clock = {
      now: () =>
        clockCalls++ < 4
          ? "2026-08-12T08:00:00.000Z"
          : "2026-08-12T08:00:00.010Z",
    };
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 5 })],
      { maxWallTimeMs: 1 },
      { clock },
    );
    try {
      const suspended = await fixture.runtime.advanceResearch({ runId: fixture.runId });
      expect(suspended.state).toMatchObject({
        type: "budget_exhausted",
        exhaustedDimension: "wall_time",
        remainingBudget: { wallTimeMs: 0 },
      });
      if (suspended.state.type !== "budget_exhausted") {
        throw new Error("测试要求 budget_exhausted");
      }
      expect(suspended.state.modelTurns).toHaveLength(1);
      expect(suspended.state.researchStartedAt).toBe("2026-08-12T08:00:00.000Z");
    } finally {
      fixture.runtime.close();
    }
  });

  it("blocks draft generation before calling the model when no Model Turn remains", async () => {
    const fixture = await createApprovedLoopRun(
      [
        turn("read", "read_source", {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        }),
        turn("evidence", "record_evidence", { observationId: "observation-001" }),
        turn("claim", "propose_claim", {
          kind: "source_fact",
          text: "Run Journal 是 canonical history。",
          evidenceIds: ["evidence-event-008"],
        }),
        turn("complete", "complete_research", { unresolvedQuestions: [] }),
      ],
      { maxModelTurns: 5 },
      {
        learningArtifactProposals: [{
          title: "不应调用的提案",
          summary: "预算检查必须发生在模型副作用之前。",
          claimIds: ["claim-event-010"],
        }],
      },
    );
    try {
      await fixture.runtime.advanceResearch({ runId: fixture.runId });
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputRoot, "must-not-call-model.md"),
        }),
      ).rejects.toThrow(/Evidence/);
      expect(fixture.model.learningArtifactRequests).toEqual([]);
    } finally {
      fixture.runtime.close();
    }
  });

  it("keeps plan approval wait outside the Evidence Gate wall-time check", async () => {
    let clockCalls = 0;
    const clock: Clock = {
      now: () =>
        clockCalls++ < 2
          ? "2026-08-12T08:00:00.000Z"
          : "2026-08-12T10:00:00.000Z",
    };
    const model = new ScriptedModel(
      [{
        title: "验证审批等待不消耗研究预算",
        objectives: ["形成一条可发布来源事实"],
        steps: [{ id: "step-001", description: "读取、登记并完成研究" }],
      }],
      [{
        title: "审批等待与研究预算",
        summary: "Evidence Gate 只计算 Research Loop 的活动墙钟时间。",
        claimIds: ["claim-event-010"],
      }],
      [
        turn("read", "read_source", {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        }),
        turn("evidence", "record_evidence", {
          observationId: "observation-001",
        }),
        turn("claim", "propose_claim", {
          kind: "source_fact",
          text: "Run Journal 是 canonical history。",
          evidenceIds: ["evidence-event-008"],
        }),
        turn("complete", "complete_research", { unresolvedQuestions: [] }),
      ],
    );
    const runtimeHome = await createTemporaryDirectory("research-loop-gate-runtime-");
    const sourceRoot = await createTemporaryDirectory("research-loop-gate-source-");
    const outputRoot = await createTemporaryDirectory("research-loop-gate-output-");
    await writeFile(
      join(sourceRoot, "journal.md"),
      "Run Journal 是 canonical history。\n",
      "utf8",
    );
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model,
      clock,
      ids: sequentialIds(),
    });

    try {
      const waiting = await runtime.createRun({
        question: "审批等待是否消耗 Research Loop wall time？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 4_096,
          maxTotalBytes: 4_096,
        },
        runBudget: { ...generousBudget(), maxWallTimeMs: 1 },
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试要求等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      await runtime.advanceResearch({ runId: waiting.runId });

      await expect(
        runtime.proposeLearningArtifact({
          runId: waiting.runId,
          targetPath: join(outputRoot, "approval-wait.md"),
        }),
      ).resolves.toMatchObject({
        state: { type: "waiting_publication_approval" },
      });
    } finally {
      runtime.close();
    }
  });
});

function turn(
  intentId: string,
  name: "search_sources" | "read_source" | "record_evidence" | "propose_claim" | "complete_research",
  input: unknown,
) {
  return {
    text: `执行 ${name}`,
    evidenceGaps: [],
    finishReason: "tool_calls" as const,
    toolIntents: [{ intentId, name, input }],
  };
}

async function createApprovedLoopRun(
  turns: ConstructorParameters<typeof ScriptedModel>[2],
  limits: Partial<RunBudget> = {},
  runtimeOptions: Pick<
    OpenRuntimeOptions,
    "maxModelViewBytes" | "clock"
  > & {
    /** 可选 draft 模型脚本，用于断言预算在 Model Port 调用之前阻断副作用。 */
    readonly learningArtifactProposals?: ConstructorParameters<typeof ScriptedModel>[1];
  } = {},
) {
  const runtimeHome = await createTemporaryDirectory("research-loop-errors-runtime-");
  const sourceRoot = await createTemporaryDirectory("research-loop-errors-source-");
  const outputRoot = await createTemporaryDirectory("research-loop-errors-output-");
  await Promise.all([
    writeFile(join(sourceRoot, "journal.md"), "Run Journal 是 canonical history。\n", "utf8"),
    writeFile(join(sourceRoot, "other.md"), "另一份 distinct source。\n", "utf8"),
    writeFile(join(sourceRoot, "tiny.md"), "x", "utf8"),
  ]);
  const model = new ScriptedModel(
    [{
      title: "测试 Research Loop observation",
      objectives: ["保持错误可见"],
      steps: [{ id: "step-001", description: "运行 scripted turns" }],
    }],
    runtimeOptions.learningArtifactProposals ?? [],
    turns,
  );
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    outputRoot,
    model,
    clock: runtimeOptions.clock ?? fixedClock(),
    ids: sequentialIds(),
    ...(runtimeOptions.maxModelViewBytes === undefined
      ? {}
      : { maxModelViewBytes: runtimeOptions.maxModelViewBytes }),
  });
  const waiting = await runtime.createRun({
    question: "Research Tool 错误如何回到模型？",
    sourceScope: {
      roots: [sourceRoot],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 4_096,
      maxTotalBytes: 4_096,
    },
    runBudget: { ...generousBudget(), ...limits },
  });
  if (waiting.state.type !== "waiting_plan_approval") throw new Error("测试要求计划审批");
  await runtime.approvePlan({
    runId: waiting.runId,
    bindingHash: waiting.state.approvalBinding.bindingHash,
  });
  return { runtime, runId: waiting.runId, model, outputRoot, sourceRoot };
}

function generousBudget(): RunBudget {
  return {
    version: "budget-v1",
    maxModelTurns: 8,
    maxToolCalls: 8,
    maxDistinctSources: 3,
    maxSourceBytes: 4_096,
    maxWallTimeMs: 60_000,
  };
}

function fixedClock(): Clock {
  return { now: () => "2026-08-12T08:00:00.000Z" };
}

function sequentialIds(): IdGenerator {
  let event = 0;
  let toolCall = 0;
  let observation = 0;
  return {
    nextRunId: () => "run-loop-001",
    nextEventId: () => `event-${String(++event).padStart(3, "0")}`,
    nextApprovalId: () => "approval-plan-001",
    nextToolCallId: () => `tool-call-${String(++toolCall).padStart(3, "0")}`,
    nextObservationId: () =>
      `observation-${String(++observation).padStart(3, "0")}`,
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
