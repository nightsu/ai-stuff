import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ModelGenerationAbortedError,
  ResearchAgentRuntime,
  ScriptedModel,
} from "../../src/index.js";
import type {
  Clock,
  IdGenerator,
  ModelPort,
  SourceSearchPort,
} from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("ResearchAgentRuntime durable Run control", () => {
  it("resumes a user-paused Run from its durable pending tool without regenerating the completed Model Turn", async () => {
    const runtimeHome = await temporaryDirectory("run-pause-runtime-");
    const sourceRoot = await temporaryDirectory("run-pause-source-");
    let modelCalls = 0;
    let runtime: ResearchAgentRuntime;
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => {
        modelCalls += 1;
        return {
          text: "研究完成。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "complete-intent",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          }],
        };
      },
    };
    let paused = false;
    const [clock, setTime] = controlledClock();
    runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock,
      ids: sequentialIds(),
      researchLoopHooks: {
        afterModelTurnJournalAppend: async () => {
          if (paused) return;
          paused = true;
          await runtime.pauseRun({ runId: "run-001" });
        },
      },
    });

    const waiting = await createWaitingRun(runtime, sourceRoot);
    if (waiting.state.type !== "waiting_plan_approval") {
      throw new Error("测试夹具没有等待计划审批");
    }
    await runtime.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.state.approvalBinding.bindingHash,
    });
    const suspended = await runtime.advanceResearch({ runId: waiting.runId });
    expect(suspended.state).toMatchObject({
      type: "user_paused",
      suspendedState: {
        type: "researching",
        modelTurns: [{ toolIntents: [{ intentId: "complete-intent" }] }],
        pendingToolIntents: [{ intentId: "complete-intent" }],
      },
    });
    expect(modelCalls).toBe(1);
    runtime.close();
    setTime("2026-08-12T09:01:00.000Z");

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model: new ScriptedModel([]),
      clock,
      ids: sequentialIds(100),
    });
    try {
      const resumed = await restarted.resumeRun({ runId: waiting.runId });
      expect(resumed.state).toMatchObject({
        type: "researching",
        suspendedDurationMs: 60_000,
      });
      const completed = await restarted.advanceResearch({ runId: waiting.runId });
      expect(completed.state.type).toBe("research_complete");
      expect(modelCalls).toBe(1);
      const trace = await restarted.traceRun({ runId: waiting.runId });
      expect(trace.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["run_paused", "run_resumed"]),
      );
    } finally {
      restarted.close();
    }
  });

  it("approves a larger Run Budget version and resumes the exact incomplete pending work", async () => {
    const runtimeHome = await temporaryDirectory("run-budget-runtime-");
    const sourceRoot = await temporaryDirectory("run-budget-source-");
    let modelCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => {
        modelCalls += 1;
        return {
          text: "先形成一个可观察失败，再完成研究。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [
            {
              intentId: "not-last",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            },
            {
              intentId: "complete",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            },
          ],
        };
      },
    };
    const [clock, setTime] = controlledClock();
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock,
      ids: sequentialIds(),
    });

    try {
      const waiting = await runtime.createRun({
        question: "预算扩展如何恢复 pending intent？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 1_000,
          maxTotalBytes: 10_000,
        },
        runBudget: {
          version: "budget-v1",
          maxModelTurns: 4,
          maxToolCalls: 1,
          maxDistinctSources: 2,
          maxSourceBytes: 10_000,
          maxWallTimeMs: 30_000,
        },
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const exhausted = await runtime.advanceResearch({ runId: waiting.runId });
      expect(exhausted.state).toMatchObject({
        type: "budget_exhausted",
        researchOutcome: "incomplete",
        exhaustedDimension: "tool_calls",
        pendingToolIntents: [{ intentId: "complete" }],
        researchToolObservations: [{ intentId: "not-last" }],
      });
      expect(modelCalls).toBe(1);
      setTime("2026-08-12T09:01:00.000Z");

      const resumed = await runtime.extendRunBudget({
        runId: waiting.runId,
        runBudget: {
          version: "budget-v2",
          maxModelTurns: 4,
          maxToolCalls: 3,
          maxDistinctSources: 2,
          maxSourceBytes: 10_000,
          maxWallTimeMs: 30_000,
        },
      });
      expect(resumed.runBudget.version).toBe("budget-v2");
      expect(resumed.runBudgetApprovalReceipts).toHaveLength(1);
      expect(resumed.state).toMatchObject({
        type: "researching",
        suspendedDurationMs: 60_000,
        pendingToolIntents: [{ intentId: "complete" }],
        researchToolObservations: [{ intentId: "not-last" }],
      });
      const completed = await runtime.advanceResearch({ runId: waiting.runId });
      expect(completed.state.type).toBe("research_complete");
      expect(modelCalls).toBe(1);
    } finally {
      runtime.close();
    }
  });

  it("cancels before model work and rejects every later attempt to resume or advance", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-before-model-");
    const sourceRoot = await temporaryDirectory("run-cancel-before-model-source-");
    let modelCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("cancelled Run 不应生成 draft");
      },
      generateResearchTurn: async () => {
        modelCalls += 1;
        throw new Error("cancelled Run 不应调用模型");
      },
    };
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const cancelled = await runtime.cancelRun({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: { type: "researching" },
      });
      await expect(runtime.resumeRun({ runId: waiting.runId })).rejects.toThrow();
      await expect(runtime.advanceResearch({ runId: waiting.runId }))
        .resolves.toMatchObject({ state: { type: "cancelled" } });
      expect(modelCalls).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("cancels after a Model Turn is durable but before its queued tool starts", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-before-tool-");
    const sourceRoot = await temporaryDirectory("run-cancel-before-tool-source-");
    let runtime: ResearchAgentRuntime;
    let cancelledBeforeTool = false;
    runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(true),
      clock: fixedClock(),
      ids: sequentialIds(),
      researchLoopHooks: {
        afterModelTurnJournalAppend: async () => {
          if (cancelledBeforeTool) return;
          cancelledBeforeTool = true;
          await runtime.cancelRun({ runId: "run-001" });
        },
      },
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });

      const cancelled = await runtime.advanceResearch({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: {
          type: "researching",
          pendingToolIntents: [{ intentId: "complete-intent" }],
          researchToolObservations: [],
        },
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.slice(-2).map((event) => event.type)).toEqual([
        "model_turn_completed",
        "run_cancelled",
      ]);
    } finally {
      runtime.close();
    }
  });

  it("persists cancellation during a model stream and never commits its partial turn", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-stream-");
    const sourceRoot = await temporaryDirectory("run-cancel-stream-source-");
    let runtime: ResearchAgentRuntime;
    let calls = 0;
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => {
        calls += 1;
        await runtime.cancelRun({ runId: "run-001" });
        throw new ModelGenerationAbortedError();
      },
    };
    runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      await expect(runtime.advanceResearch({ runId: waiting.runId }))
        .rejects.toBeInstanceOf(ModelGenerationAbortedError);
      const cancelled = await runtime.inspectRun({ runId: waiting.runId });
      expect(cancelled.state.type).toBe("cancelled");
      expect(JSON.stringify(cancelled)).not.toContain("partial");
      expect((await runtime.traceRun({ runId: waiting.runId })).events)
        .not.toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "model_turn_completed" }),
        ]));
      expect(calls).toBe(1);
    } finally {
      runtime.close();
    }
  });

  it("closes the durable Retry Attempt when cancellation aborts a model stream", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-retry-stream-");
    const sourceRoot = await temporaryDirectory("run-cancel-retry-source-");
    let runtime: ResearchAgentRuntime;
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => {
        await runtime.cancelRun({ runId: "run-001" });
        throw new ModelGenerationAbortedError();
      },
    };
    runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });

      await expect(runtime.advanceResearch({ runId: waiting.runId }))
        .rejects.toBeInstanceOf(ModelGenerationAbortedError);
      const cancelled = await runtime.inspectRun({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: {
          type: "researching",
          retryAttempts: [{
            retrySequenceKind: "model_turn",
            outcome: "permanent_failure",
            failure: {
              category: "model_permanent",
              code: "model_generation_aborted",
            },
          }],
        },
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.slice(-2).map((event) => event.type)).toEqual([
        "run_cancelled",
        "retry_attempt_failed",
      ]);
    } finally {
      runtime.close();
    }
  });

  it("journals a concurrently completed Model Turn inside the cancelled snapshot without executing its queued tool", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-race-");
    const sourceRoot = await temporaryDirectory("run-cancel-race-source-");
    let runtime: ResearchAgentRuntime;
    let cancelBeforeAppend = true;
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => ({
        text: "并发完成的结果。",
        evidenceGaps: [],
        finishReason: "tool_calls",
        toolIntents: [{
          intentId: "late-complete",
          name: "complete_research",
          input: { unresolvedQuestions: [] },
        }],
      }),
    };
    runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
      researchLoopHooks: {
        beforeModelTurnJournalAppend: async () => {
          if (!cancelBeforeAppend) return;
          cancelBeforeAppend = false;
          await runtime.cancelRun({ runId: "run-001" });
        },
      },
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const cancelled = await runtime.advanceResearch({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: {
          type: "researching",
          modelTurns: [{ toolIntents: [{ intentId: "late-complete" }] }],
          pendingToolIntents: [{ intentId: "late-complete" }],
          researchToolObservations: [],
        },
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["run_cancelled", "model_turn_completed"]),
      );
    } finally {
      runtime.close();
    }
  });

  it("journals a completed Search result inside the cancelled snapshot without executing later queued work", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-search-race-");
    const sourceRoot = await temporaryDirectory("run-cancel-search-source-");
    let runtime: ResearchAgentRuntime;
    let searchCalls = 0;
    let cancelBeforeObservation = true;
    const sourceSearch: SourceSearchPort = {
      search: async () => {
        searchCalls += 1;
        return [{
          rootIndex: 0,
          relativePath: "source.md",
          lineNumber: 1,
          lineText: "fact",
        }];
      },
    };
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => ({
        text: "先搜索，再完成。",
        evidenceGaps: [],
        finishReason: "tool_calls",
        toolIntents: [
          {
            intentId: "search-intent",
            name: "search_sources",
            input: { query: "fact", maxResults: 5 },
          },
          {
            intentId: "complete-intent",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          },
        ],
      }),
    };
    runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      sourceSearch,
      clock: fixedClock(),
      ids: sequentialIds(),
      researchLoopHooks: {
        afterSearchResultArtifactWrite: async () => {
          if (!cancelBeforeObservation) return;
          cancelBeforeObservation = false;
          await runtime.cancelRun({ runId: "run-001" });
        },
      },
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });

      const cancelled = await runtime.advanceResearch({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: {
          type: "researching",
          researchToolObservations: [{ intentId: "search-intent", status: "succeeded" }],
          pendingToolIntents: [{ intentId: "complete-intent" }],
        },
      });
      expect(searchCalls).toBe(1);
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.slice(-2).map((event) => event.type)).toEqual([
        "run_cancelled",
        "research_tool_observed",
      ]);
    } finally {
      runtime.close();
    }
  });

  it("journals a completed Research completion inside the cancelled snapshot without changing the terminal outcome", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-completion-race-");
    const sourceRoot = await temporaryDirectory("run-cancel-completion-source-");
    let runtime: ResearchAgentRuntime;
    let cancelBeforeCompletion = true;
    runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(true),
      clock: fixedClock(),
      ids: sequentialIds(),
      researchLoopHooks: {
        beforeCompletionJournalAppend: async () => {
          if (!cancelBeforeCompletion) return;
          cancelBeforeCompletion = false;
          await runtime.cancelRun({ runId: "run-001" });
        },
      },
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });

      const cancelled = await runtime.advanceResearch({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: {
          type: "research_complete",
          pendingToolIntents: [],
          completion: { unresolvedQuestions: [] },
          researchToolObservations: [{
            intentId: "complete-intent",
            status: "succeeded",
          }],
        },
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.slice(-2).map((event) => event.type)).toEqual([
        "run_cancelled",
        "research_completed",
      ]);
    } finally {
      runtime.close();
    }
  });

  it("cancels every suspended Run shape without making it resumable again", async () => {
    const sourceRoot = await temporaryDirectory("run-cancel-suspended-source-");

    const waitingRuntime = ResearchAgentRuntime.open({
      runtimeHome: await temporaryDirectory("run-cancel-waiting-plan-"),
      model: new ScriptedModel([learningPlan()]),
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    try {
      const waiting = await createWaitingRun(waitingRuntime, sourceRoot);
      const cancelled = await waitingRuntime.cancelRun({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: { type: "waiting_plan_approval" },
      });
      await expect(waitingRuntime.resumeRun({ runId: waiting.runId })).rejects.toThrow();
    } finally {
      waitingRuntime.close();
    }

    const pausedRuntime = ResearchAgentRuntime.open({
      runtimeHome: await temporaryDirectory("run-cancel-user-paused-"),
      model: new ScriptedModel([learningPlan()]),
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    try {
      const waiting = await createWaitingRun(pausedRuntime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await pausedRuntime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      await pausedRuntime.pauseRun({ runId: waiting.runId });
      const cancelled = await pausedRuntime.cancelRun({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: { type: "user_paused" },
      });
      await expect(pausedRuntime.resumeRun({ runId: waiting.runId })).rejects.toThrow();
    } finally {
      pausedRuntime.close();
    }

    const budgetRuntime = ResearchAgentRuntime.open({
      runtimeHome: await temporaryDirectory("run-cancel-budget-exhausted-"),
      model: completionModel(),
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    try {
      const waiting = await createWaitingRunWithBudget(budgetRuntime, sourceRoot, {
        maxToolCalls: 1,
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await budgetRuntime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const exhausted = await budgetRuntime.advanceResearch({ runId: waiting.runId });
      expect(exhausted.state.type).toBe("budget_exhausted");
      const cancelled = await budgetRuntime.cancelRun({ runId: waiting.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: { type: "budget_exhausted" },
      });
      await expect(budgetRuntime.extendRunBudget({
        runId: waiting.runId,
        runBudget: { ...cancelled.runBudget, version: "budget-v2", maxToolCalls: 2 },
      })).rejects.toThrow();
    } finally {
      budgetRuntime.close();
    }

    const publication = await createWaitingPublicationRun();
    try {
      const cancelled = await publication.runtime.cancelRun({ runId: publication.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: { type: "waiting_publication_approval" },
      });
      await expect(publication.runtime.approvePublication({
        runId: publication.runId,
        bindingHash: publication.bindingHash,
      })).rejects.toThrow();
    } finally {
      publication.runtime.close();
    }
  });

  it("rejects unchanged, shrinking, and premature Run Budget extensions", async () => {
    const sourceRoot = await temporaryDirectory("run-budget-validation-source-");
    const activeRuntime = ResearchAgentRuntime.open({
      runtimeHome: await temporaryDirectory("run-budget-premature-"),
      model: new ScriptedModel([learningPlan()]),
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    try {
      const waiting = await createWaitingRun(activeRuntime, sourceRoot);
      await expect(activeRuntime.extendRunBudget({
        runId: waiting.runId,
        runBudget: { ...waiting.runBudget, version: "budget-v2", maxToolCalls: 5 },
      })).rejects.toThrow();
    } finally {
      activeRuntime.close();
    }

    const runtime = ResearchAgentRuntime.open({
      runtimeHome: await temporaryDirectory("run-budget-invalid-"),
      model: completionModel(),
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    try {
      const waiting = await createWaitingRunWithBudget(runtime, sourceRoot, {
        maxToolCalls: 1,
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const exhausted = await runtime.advanceResearch({ runId: waiting.runId });
      expect(exhausted.state.type).toBe("budget_exhausted");

      await expect(runtime.extendRunBudget({
        runId: waiting.runId,
        runBudget: { ...exhausted.runBudget },
      })).rejects.toThrow();
      await expect(runtime.extendRunBudget({
        runId: waiting.runId,
        runBudget: {
          ...exhausted.runBudget,
          version: "budget-v2",
          maxToolCalls: 2,
          maxSourceBytes: exhausted.runBudget.maxSourceBytes - 1,
        },
      })).rejects.toThrow();
    } finally {
      runtime.close();
    }
  });

  it("restores budget exhaustion after completion to research_complete provenance", async () => {
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: await temporaryDirectory("run-budget-complete-origin-"),
      model: completionModel(true),
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    const sourceRoot = await temporaryDirectory("run-budget-complete-source-");
    try {
      const waiting = await createWaitingRunWithBudget(runtime, sourceRoot, {
        maxToolCalls: 1,
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const exhausted = await runtime.advanceResearch({ runId: waiting.runId });
      expect(exhausted.state).toMatchObject({
        type: "budget_exhausted",
        researchOutcome: "research_complete",
        completion: { unresolvedQuestions: [] },
      });

      const resumed = await runtime.extendRunBudget({
        runId: waiting.runId,
        runBudget: {
          ...exhausted.runBudget,
          version: "budget-v2",
          maxToolCalls: 2,
        },
      });
      expect(resumed.state).toMatchObject({
        type: "research_complete",
        completion: { unresolvedQuestions: [] },
        pendingToolIntents: [],
      });
    } finally {
      runtime.close();
    }
  });

  it("never resumes or restarts work for completed and failed terminal Runs", async () => {
    const publication = await createWaitingPublicationRun();
    try {
      const waiting = await publication.runtime.inspectRun({ runId: publication.runId });
      if (waiting.state.type !== "waiting_publication_approval") {
        throw new Error("测试夹具没有等待 publication approval");
      }
      await publication.runtime.approvePublication({
        runId: publication.runId,
        bindingHash: publication.bindingHash,
      });
      const completed = await publication.runtime.publishLearningArtifact({
        runId: publication.runId,
      });
      expect(completed.state.type).toBe("completed");
      await expect(publication.runtime.resumeRun({ runId: publication.runId }))
        .rejects.toThrow();
      await expect(publication.runtime.cancelRun({ runId: publication.runId }))
        .rejects.toThrow();
    } finally {
      publication.runtime.close();
    }

    const sourceRoot = await temporaryDirectory("run-terminal-failed-source-");
    const failedRuntime = ResearchAgentRuntime.open({
      runtimeHome: await temporaryDirectory("run-terminal-failed-runtime-"),
      model: {
        proposePlan: async () => learningPlan(),
        proposeLearningArtifact: async () => {
          throw new Error("failed Run 不应生成 draft");
        },
        generateResearchTurn: async () => {
          throw new Error("permanent model failure");
        },
      },
      clock: fixedClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 1,
        toolMaxAttempts: 1,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
    });
    try {
      const waiting = await createWaitingRun(failedRuntime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有等待计划审批");
      }
      await failedRuntime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const failed = await failedRuntime.advanceResearch({ runId: waiting.runId });
      expect(failed.state.type).toBe("failed");
      await expect(failedRuntime.resumeRun({ runId: waiting.runId })).rejects.toThrow();
      await expect(failedRuntime.cancelRun({ runId: waiting.runId })).rejects.toThrow();
      await expect(failedRuntime.advanceResearch({ runId: waiting.runId }))
        .resolves.toMatchObject({ state: { type: "failed" } });
    } finally {
      failedRuntime.close();
    }
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createWaitingRun(
  runtime: ResearchAgentRuntime,
  sourceRoot: string,
) {
  return createWaitingRunWithBudget(runtime, sourceRoot);
}

async function createWaitingRunWithBudget(
  runtime: ResearchAgentRuntime,
  sourceRoot: string,
  budgetOverrides: Partial<{
    /** 覆盖批准的 Model Turn 上限。 */
    readonly maxModelTurns: number;
    /** 覆盖批准的逻辑 Research Tool 调用上限。 */
    readonly maxToolCalls: number;
    /** 覆盖批准的 distinct Source Snapshot 上限。 */
    readonly maxDistinctSources: number;
    /** 覆盖批准的累计来源字节上限。 */
    readonly maxSourceBytes: number;
    /** 覆盖批准的 Research Loop wall-time 上限。 */
    readonly maxWallTimeMs: number;
  }> = {},
) {
  return runtime.createRun({
    question: "如何恢复暂停的 Research Run？",
    sourceScope: {
      roots: [sourceRoot],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 1_000,
      maxTotalBytes: 10_000,
    },
    runBudget: {
      version: "budget-v1",
      maxModelTurns: 4,
      maxToolCalls: 4,
      maxDistinctSources: 2,
      maxSourceBytes: 10_000,
      maxWallTimeMs: 30_000,
      ...budgetOverrides,
    },
  });
}

function completionModel(completeImmediately = false): ModelPort {
  return {
    proposePlan: async () => learningPlan(),
    proposeLearningArtifact: async () => {
      throw new Error("测试不会生成 Learning Artifact");
    },
    generateResearchTurn: async () => ({
      text: "显式完成研究。",
      evidenceGaps: [],
      finishReason: "tool_calls",
      toolIntents: completeImmediately
        ? [{
            intentId: "complete-intent",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          }]
        : [
            {
              intentId: "not-last",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            },
            {
              intentId: "complete-intent",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            },
          ],
    }),
  };
}

async function createWaitingPublicationRun(): Promise<{
  /** 保持打开、可继续发出控制命令的 Runtime。 */
  readonly runtime: ResearchAgentRuntime;
  /** 已进入 publication wait 的 Research Run identity。 */
  readonly runId: string;
  /** 当前 exact draft/target 的用户可见 publication binding。 */
  readonly bindingHash: string;
}> {
  const runtimeHome = await temporaryDirectory("run-cancel-publication-runtime-");
  const sourceRoot = await temporaryDirectory("run-cancel-publication-source-");
  const outputRoot = await temporaryDirectory("run-cancel-publication-output-");
  await writeFile(
    join(sourceRoot, "source.md"),
    "Run Journal 是 canonical history。\n",
    "utf8",
  );
  const model: ModelPort = {
    proposePlan: async () => learningPlan(),
    proposeLearningArtifact: async (request) => ({
      title: "可取消的 publication wait",
      summary: "只使用已经登记的 Claim。",
      claimIds: request.claims.map((claim) => claim.claimId),
    }),
  };
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    outputRoot,
    model,
    clock: fixedClock(),
    ids: sequentialIds(),
  });
  const waiting = await createWaitingRun(runtime, sourceRoot);
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试夹具没有等待计划审批");
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
    throw new Error("测试夹具没有成功读取来源");
  }
  const observation = read.state.sourceReadObservations[0];
  if (observation?.status !== "succeeded") {
    throw new Error("测试夹具没有成功来源 observation");
  }
  const evidenced = await runtime.recordEvidence({
    runId: waiting.runId,
    observationId: observation.observationId,
  });
  if (evidenced.state.type !== "researching") {
    throw new Error("测试夹具没有登记 Evidence");
  }
  const evidence = evidenced.state.evidenceRecords[0];
  if (evidence === undefined) throw new Error("测试夹具缺少 Evidence");
  await runtime.recordClaim({
    runId: waiting.runId,
    kind: "source_fact",
    text: "Run Journal 是 canonical history。",
    evidenceIds: [evidence.evidenceId],
  });
  const publicationWaiting = await runtime.proposeLearningArtifact({
    runId: waiting.runId,
    targetPath: join(outputRoot, "cancelled.md"),
  });
  if (publicationWaiting.state.type !== "waiting_publication_approval") {
    throw new Error("测试夹具没有等待 publication approval");
  }
  return {
    runtime,
    runId: waiting.runId,
    bindingHash: publicationWaiting.state.publicationBinding.bindingHash,
  };
}

function learningPlan() {
  return {
    title: "验证可恢复控制",
    objectives: ["暂停后从 canonical facts 恢复"],
    steps: [{ id: "step-1", description: "推进一次 Research Loop" }],
  } as const;
}

function fixedClock(): Clock {
  return { now: () => "2026-08-12T09:00:00.000Z" };
}

function controlledClock(): readonly [Clock, (time: string) => void] {
  let current = "2026-08-12T09:00:00.000Z";
  return [
    { now: () => current },
    (time: string) => {
      current = time;
    },
  ] as const;
}

function sequentialIds(start = 0): IdGenerator {
  let value = start;
  const next = (prefix: string) => `${prefix}-${String(++value).padStart(3, "0")}`;
  return {
    nextRunId: () => next("run"),
    nextEventId: () => next("event"),
    nextApprovalId: () => next("approval"),
    nextToolCallId: () => next("tool-call"),
    nextObservationId: () => next("observation"),
  };
}
