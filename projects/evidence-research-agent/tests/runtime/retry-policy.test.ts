import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPlanApprovalBinding,
  InfrastructureFailureError,
  ResearchAgentRuntime,
} from "../../src/index.js";
import type {
  Clock,
  IdGenerator,
  ModelPort,
  ModelView,
  RetryScheduler,
  ResearchRunEvent,
  RunBudget,
} from "../../src/index.js";
import {
  IllegalRunEventError,
  reduceRunEvents,
} from "../../src/domain/reducer.js";
import { parseResearchRunEvent } from "../../src/domain/schemas.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ResearchAgentRuntime retry policy", () => {
  it("retries a transient Model Turn with the provider hint without creating another logical turn", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-model-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-model-source-");
    await writeFile(join(sourceRoot, "journal.md"), "Run Journal 是 canonical history。\n", "utf8");
    const views: ModelView[] = [];
    let generationCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => ({
        title: "验证 Model retry",
        objectives: ["保留每个物理 attempt"],
        steps: [{ id: "step-001", description: "重试未完成 generation" }],
      }),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async (view) => {
        views.push(structuredClone(view));
        generationCalls += 1;
        if (generationCalls === 1) {
          throw new InfrastructureFailureError("rate_limited", {
            retryAfterMs: 250,
          });
        }
        return {
          text: "重试后显式完成。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "complete",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          }],
        };
      },
    };
    const waits: number[] = [];
    const retryScheduler: RetryScheduler = {
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    };
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: incrementingClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 3,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
      retryScheduler,
    });

    try {
      const waiting = await runtime.createRun({
        question: "Model rate limit 如何安全恢复？",
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

      const completed = await runtime.advanceResearch({ runId: waiting.runId });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        modelTurns: [expect.objectContaining({ text: "重试后显式完成。" })],
        operationAttempts: [
          expect.objectContaining({
            operationKind: "model_turn",
            attemptNumber: 1,
            outcome: "retryable_failure",
            failure: {
              category: "infrastructure_transient",
              code: "rate_limited",
              retryAfterMs: 250,
            },
            retryDelayMs: 250,
          }),
          expect.objectContaining({
            operationKind: "model_turn",
            attemptNumber: 2,
            outcome: "succeeded",
          }),
        ],
      });
      expect(generationCalls).toBe(2);
      expect(views).toHaveLength(2);
      expect(waits).toEqual([250]);

      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.filter((event) => event.type === "model_turn_completed"))
        .toHaveLength(1);
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "operation_attempt_failed",
          operationKind: "model_turn",
          attemptNumber: 1,
          attemptOutcome: "retryable_failure",
          attemptDurationMs: 5,
          retryPolicyVersion: "retry-v1",
          failureCategory: "infrastructure_transient",
          failureCode: "rate_limited",
          retryDelayMs: 250,
        }),
        expect.objectContaining({
          type: "model_turn_completed",
          attemptNumber: 2,
          attemptOutcome: "succeeded",
        }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it("suspends after the frozen Model retry limit without claiming another retry", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-exhausted-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-exhausted-source-");
    const model: ModelPort = {
      proposePlan: async () => ({
        title: "验证 retry exhaustion",
        objectives: ["达到 attempt 上限后暂停"],
        steps: [{ id: "step-001", description: "持续返回瞬时错误" }],
      }),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => {
        throw new InfrastructureFailureError("service_unavailable");
      },
    };
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: incrementingClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
      retryScheduler: { wait: async () => undefined },
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.bindingHash,
      });

      const suspended = await runtime.advanceResearch({ runId: waiting.runId });
      expect(suspended.state).toMatchObject({
        type: "retry_exhausted",
        operationKind: "model_turn",
        attemptsUsed: 2,
        failure: {
          category: "infrastructure_transient",
          code: "service_unavailable",
        },
        operationAttempts: [
          expect.objectContaining({
            attemptNumber: 1,
            outcome: "retryable_failure",
            retryDelayMs: 10,
          }),
          expect.objectContaining({
            attemptNumber: 2,
            outcome: "retry_exhausted",
          }),
        ],
      });
      if (suspended.state.type !== "retry_exhausted") {
        throw new Error("测试要求 retry_exhausted 状态");
      }
      expect(suspended.state.operationAttempts[1]).not.toHaveProperty(
        "retryDelayMs",
      );
    } finally {
      runtime.close();
    }
  });

  it("recovers a durable in-progress Model attempt after restart with the frozen policy", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-restart-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-restart-source-");
    let interrupt = true;
    let generationCalls = 0;
    const model = completingModel(() => {
      generationCalls += 1;
    });
    const policy = {
      version: "retry-frozen-v1",
      modelMaxAttempts: 3,
      toolMaxAttempts: 2,
      baseDelayMs: 15,
      maxDelayMs: 100,
    } as const;
    const ids = sequentialIds();
    const clock = incrementingClock();
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock,
      ids,
      retryPolicy: policy,
      retryScheduler: { wait: async () => undefined },
      researchLoopHooks: {
        afterOperationAttemptStarted: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟 started fact 后进程中断");
        },
      },
    });

    const waiting = await createWaitingRun(first, sourceRoot);
    await first.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.bindingHash,
    });
    await expect(
      first.advanceResearch({ runId: waiting.runId }),
    ).rejects.toMatchObject({ name: "ResearchLoopError" });
    const interrupted = await first.inspectRun({ runId: waiting.runId });
    expect(interrupted.state).toMatchObject({
      type: "researching",
      operationAttempts: [expect.objectContaining({
        attemptNumber: 1,
        outcome: "in_progress",
        retryPolicy: policy,
      })],
    });
    expect(generationCalls).toBe(0);
    first.close();

    const waits: number[] = [];
    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock,
      ids,
      retryPolicy: {
        version: "changed-runtime-policy",
        modelMaxAttempts: 1,
        toolMaxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
      retryScheduler: {
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    });
    try {
      const completed = await restarted.advanceResearch({ runId: waiting.runId });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        operationAttempts: [
          expect.objectContaining({
            attemptNumber: 1,
            outcome: "retryable_failure",
            failure: {
              category: "infrastructure_transient",
              code: "model_turn_interrupted",
            },
            retryPolicy: policy,
          }),
          expect.objectContaining({
            attemptNumber: 2,
            outcome: "succeeded",
            retryPolicy: policy,
          }),
        ],
      });
      expect(waits).toEqual([15]);
      expect(generationCalls).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("retries transient search attempts under one logical Tool Call", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-search-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-search-source-");
    let searchCalls = 0;
    let modelCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => ({
        title: "验证 search retry",
        objectives: ["只消费一个逻辑 Tool Call"],
        steps: [{ id: "step-001", description: "重试瞬时 search failure" }],
      }),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? {
              text: "先搜索。",
              evidenceGaps: [],
              finishReason: "tool_calls",
              toolIntents: [{
                intentId: "search",
                name: "search_sources",
                input: { query: "canonical", maxResults: 1 },
              }],
            }
          : {
              text: "搜索完成。",
              evidenceGaps: [],
              finishReason: "tool_calls",
              toolIntents: [{
                intentId: "complete",
                name: "complete_research",
                input: { unresolvedQuestions: [] },
              }],
            };
      },
    };
    const waits: number[] = [];
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      sourceSearch: {
        search: async () => {
          searchCalls += 1;
          if (searchCalls === 1) {
            throw new InfrastructureFailureError("request_timeout", {
              retryAfterMs: 30,
            });
          }
          return [{
            rootIndex: 0,
            relativePath: "journal.md",
            lineNumber: 1,
            lineText: "Run Journal is canonical.",
          }];
        },
      },
      clock: incrementingClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
      retryScheduler: {
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    });
    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.bindingHash,
      });
      const completed = await runtime.advanceResearch({ runId: waiting.runId });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        operationAttempts: [
          expect.objectContaining({ operationKind: "model_turn", outcome: "succeeded" }),
          expect.objectContaining({
            operationKind: "search_sources",
            attemptNumber: 1,
            outcome: "retryable_failure",
            retryDelayMs: 30,
          }),
          expect.objectContaining({
            operationKind: "search_sources",
            attemptNumber: 2,
            outcome: "succeeded",
          }),
          expect.objectContaining({ operationKind: "model_turn", outcome: "succeeded" }),
        ],
      });
      if (completed.state.type !== "research_complete") {
        throw new Error("测试要求 research_complete 状态");
      }
      const searchAttempts = completed.state.operationAttempts.filter(
        (attempt) => attempt.operationKind === "search_sources",
      );
      expect(new Set(searchAttempts.map((attempt) => attempt.operationId)).size).toBe(1);
      expect(new Set(searchAttempts.map((attempt) => attempt.toolCallId)).size).toBe(1);
      expect(completed.state.researchToolObservations).toEqual([
        expect.objectContaining({
          intentId: "search",
          status: "succeeded",
          toolCallId: searchAttempts[0]?.toolCallId,
        }),
        expect.objectContaining({ intentId: "complete", status: "succeeded" }),
      ]);
      expect(waits).toEqual([30]);
      expect(searchCalls).toBe(2);
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.filter((event) => event.toolCallId === searchAttempts[0]?.toolCallId))
        .toHaveLength(4);
    } finally {
      runtime.close();
    }
  });

  it("records an ordinary search failure as a tool observation and continues the Run", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-search-failure-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-search-failure-source-");
    let modelCalls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: {
        proposePlan: async () => ({
          title: "验证普通工具失败",
          objectives: ["失败可见但不终止 Run"],
          steps: [{ id: "step-001", description: "记录 search observation" }],
        }),
        proposeLearningArtifact: async () => {
          throw new Error("测试不会生成 Learning Artifact");
        },
        generateResearchTurn: async () => {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                text: "先搜索。",
                evidenceGaps: [],
                finishReason: "tool_calls",
                toolIntents: [{
                  intentId: "search",
                  name: "search_sources",
                  input: { query: "canonical", maxResults: 1 },
                }],
              }
            : {
                text: "保留 search failure 后完成。",
                evidenceGaps: [],
                finishReason: "tool_calls",
                toolIntents: [{
                  intentId: "complete",
                  name: "complete_research",
                  input: { unresolvedQuestions: ["search unavailable"] },
                }],
              };
        },
      },
      sourceSearch: {
        search: async () => {
          throw new Error("secret provider detail");
        },
      },
      clock: incrementingClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
    });
    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.bindingHash,
      });
      const completed = await runtime.advanceResearch({ runId: waiting.runId });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        researchToolObservations: expect.arrayContaining([
          expect.objectContaining({
            intentId: "search",
            status: "failed",
            code: "search_failed",
            failure: {
              category: "tool_execution",
              code: "search_failed",
            },
          }),
        ]),
        operationAttempts: expect.arrayContaining([
          expect.objectContaining({
            operationKind: "search_sources",
            outcome: "permanent_failure",
            failure: {
              category: "tool_execution",
              code: "search_failed",
            },
          }),
        ]),
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "research_tool_observed",
          failureCategory: "tool_execution",
          failureCode: "search_failed",
        }),
      ]));
      expect(JSON.stringify(completed)).not.toContain("secret provider detail");
    } finally {
      runtime.close();
    }
  });

  it("fails terminally when a completed provider result violates the Model Turn contract", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-model-contract-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-model-contract-source-");
    let generationCalls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: {
        proposePlan: async () => ({
          title: "验证模型契约错误",
          objectives: ["不偷偷修复"],
          steps: [{ id: "step-001", description: "拒绝 invalid turn" }],
        }),
        proposeLearningArtifact: async () => {
          throw new Error("测试不会生成 Learning Artifact");
        },
        generateResearchTurn: async () => {
          generationCalls += 1;
          return {
            text: "缺少工具 intents",
            evidenceGaps: [],
            finishReason: "stop",
            toolIntents: [],
          };
        },
      },
      clock: incrementingClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 3,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
    });
    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.bindingHash,
      });
      const failed = await runtime.advanceResearch({ runId: waiting.runId });
      expect(failed.state).toMatchObject({
        type: "failed",
        operationKind: "model_turn",
        failure: { category: "model_contract", code: "invalid_model_turn" },
        operationAttempts: [expect.objectContaining({
          attemptNumber: 1,
          outcome: "permanent_failure",
        })],
      });
      expect(generationCalls).toBe(1);
      await expect(runtime.advanceResearch({ runId: waiting.runId }))
        .resolves.toMatchObject({ state: { type: "failed" } });
      expect(generationCalls).toBe(1);
    } finally {
      runtime.close();
    }
  });

  it("does not resample a Model Turn committed before an injected process interruption", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-committed-turn-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-committed-turn-source-");
    let generationCalls = 0;
    let interrupt = true;
    const model = completingModel(() => {
      generationCalls += 1;
    });
    const ids = sequentialIds();
    const clock = incrementingClock();
    const policy = {
      version: "retry-v1",
      modelMaxAttempts: 3,
      toolMaxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
    } as const;
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock,
      ids,
      retryPolicy: policy,
      researchLoopHooks: {
        afterModelTurnJournalAppend: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟 completed turn 后进程中断");
        },
      },
    });
    const waiting = await createWaitingRun(first, sourceRoot);
    await first.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.bindingHash,
    });
    await expect(first.advanceResearch({ runId: waiting.runId }))
      .rejects.toMatchObject({ name: "ResearchLoopError" });
    expect(generationCalls).toBe(1);
    const committed = await first.inspectRun({ runId: waiting.runId });
    expect(committed.state).toMatchObject({
      type: "researching",
      modelTurns: [expect.objectContaining({ text: "重启后完成。" })],
      operationAttempts: [expect.objectContaining({ outcome: "succeeded" })],
      pendingToolIntents: [expect.objectContaining({ intentId: "complete" })],
    });
    first.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock,
      ids,
      retryPolicy: policy,
    });
    try {
      await expect(restarted.advanceResearch({ runId: waiting.runId }))
        .resolves.toMatchObject({ state: { type: "research_complete" } });
      expect(generationCalls).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("does not claim a completed Model Turn when the SQLite commit fails", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-sqlite-failure-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-sqlite-failure-source-");
    let injectCommitFailure = true;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: completingModel(() => undefined),
      clock: incrementingClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
      researchLoopHooks: {
        beforeModelTurnJournalAppend: () => {
          if (!injectCommitFailure) return;
          injectCommitFailure = false;
          const database = new Database(join(runtimeHome, "runtime.sqlite"));
          try {
            database.exec(`CREATE TRIGGER reject_completed_turn
              BEFORE INSERT ON run_events
              WHEN NEW.type = 'model_turn_completed'
              BEGIN SELECT RAISE(ABORT, 'controlled commit failure'); END`);
          } finally {
            database.close();
          }
        },
      },
    });
    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.bindingHash,
      });
      await expect(runtime.advanceResearch({ runId: waiting.runId }))
        .rejects.toMatchObject({ name: "ResearchLoopError" });
      const projection = await runtime.inspectRun({ runId: waiting.runId });
      expect(projection.state).toMatchObject({
        type: "researching",
        modelTurns: [],
        operationAttempts: [expect.objectContaining({ outcome: "in_progress" })],
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.some((event) => event.type === "model_turn_completed"))
        .toBe(false);
      expect(trace.finalState).toBe("researching");
    } finally {
      runtime.close();
    }
  });

  it("rejects tampered retry attempt completions and terminal transitions", () => {
    const events = retryReducerEvents();
    expect(() => reduceRunEvents(events)).not.toThrow();

    const mismatchedPolicy = structuredClone(events);
    const failedAttempt = mismatchedPolicy[5];
    if (failedAttempt?.type !== "operation_attempt_failed") {
      throw new Error("测试夹具缺少 failed attempt");
    }
    mismatchedPolicy[5] = {
      ...failedAttempt,
      payload: {
        attempt: {
          ...failedAttempt.payload.attempt,
          retryPolicy: {
            ...failedAttempt.payload.attempt.retryPolicy,
            modelMaxAttempts: 99,
          },
        },
      },
    };
    expect(() => reduceRunEvents(mismatchedPolicy)).toThrow(
      IllegalRunEventError,
    );

    const prematureExhaustion = structuredClone(events);
    const terminal = prematureExhaustion[6];
    if (terminal?.type !== "run_retry_exhausted") {
      throw new Error("测试夹具缺少 retry exhausted event");
    }
    prematureExhaustion[6] = {
      ...terminal,
      payload: { ...terminal.payload, attemptsUsed: 2 },
    };
    expect(() => reduceRunEvents(prematureExhaustion)).toThrow(
      IllegalRunEventError,
    );

    expect(() => reduceRunEvents(retryReducerEvents(2))).toThrow(
      IllegalRunEventError,
    );

    const retryable = retryReducerEvents(2).slice(0, 6);
    const retryableFailure = retryable[5];
    if (retryableFailure?.type !== "operation_attempt_failed") {
      throw new Error("测试夹具缺少 retryable failure");
    }
    retryable[5] = {
      ...retryableFailure,
      payload: {
        attempt: {
          ...retryableFailure.payload.attempt,
          outcome: "retryable_failure",
          retryDelayMs: 10,
        },
      },
    };
    expect(() => reduceRunEvents(retryable)).not.toThrow();
    const tamperedDelay = structuredClone(retryable);
    const tamperedFailure = tamperedDelay[5];
    if (tamperedFailure?.type !== "operation_attempt_failed") {
      throw new Error("测试夹具缺少 retryable failure");
    }
    tamperedDelay[5] = {
      ...tamperedFailure,
      payload: {
        attempt: { ...tamperedFailure.payload.attempt, retryDelayMs: 11 },
      },
    };
    expect(() => reduceRunEvents(tamperedDelay)).toThrow(
      IllegalRunEventError,
    );

    const mismatchedTerminalFailure = structuredClone(events);
    const mismatchedTerminal = mismatchedTerminalFailure[6];
    if (mismatchedTerminal?.type !== "run_retry_exhausted") {
      throw new Error("测试夹具缺少 terminal failure");
    }
    mismatchedTerminalFailure[6] = {
      ...mismatchedTerminal,
      payload: {
        ...mismatchedTerminal.payload,
        failure: {
          ...mismatchedTerminal.payload.failure,
          retryAfterMs: 999,
        },
      },
    };
    expect(() => reduceRunEvents(mismatchedTerminalFailure)).toThrow(
      IllegalRunEventError,
    );
  });

  it("rejects malformed attempt facts at the Journal schema boundary", () => {
    const started = structuredClone(retryReducerEvents()[4]);
    if (started?.type !== "operation_attempt_started") {
      throw new Error("测试夹具缺少 started attempt");
    }
    const malformed = {
      ...started,
      payload: {
        attempt: {
          ...started.payload.attempt,
          retryPolicy: {
            ...started.payload.attempt.retryPolicy,
            baseDelayMs: 101,
            maxDelayMs: 100,
          },
        },
      },
    };
    expect(() => parseResearchRunEvent(malformed)).toThrow();
  });

  it("persists the approved Retry Policy so a restarted Runtime cannot silently replace it", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-approved-policy-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-approved-policy-source-");
    const policy = {
      version: "retry-approved-v1",
      modelMaxAttempts: 2,
      toolMaxAttempts: 2,
      baseDelayMs: 12,
      maxDelayMs: 100,
    } as const;
    const ids = sequentialIds();
    const clock = incrementingClock();
    const setupRuntime = ResearchAgentRuntime.open({
      runtimeHome,
      model: completingModel(() => undefined),
      ids,
      clock,
      retryPolicy: policy,
    });
    const waiting = await createWaitingRun(setupRuntime, sourceRoot);
    expect(waiting.approvalBinding).toMatchObject({
      retryPolicyVersion: policy.version,
      retryPolicyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await setupRuntime.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.bindingHash,
    });
    setupRuntime.close();

    let calls = 0;
    const waits: number[] = [];
    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model: {
        ...completingModel(() => undefined),
        generateResearchTurn: async () => {
          calls += 1;
          if (calls === 1) {
            throw new InfrastructureFailureError("connection_failed");
          }
          return {
            text: "使用已批准 policy 完成。",
            evidenceGaps: [],
            finishReason: "tool_calls",
            toolIntents: [{
              intentId: "complete",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            }],
          };
        },
      },
      ids,
      clock,
      retryScheduler: {
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    });
    try {
      const completed = await restarted.advanceResearch({ runId: waiting.runId });
      expect(completed).toMatchObject({
        retryPolicy: policy,
        state: {
          type: "research_complete",
          operationAttempts: [
            expect.objectContaining({ retryPolicy: policy, outcome: "retryable_failure" }),
            expect.objectContaining({ retryPolicy: policy, outcome: "succeeded" }),
          ],
        },
      });
      expect(waits).toEqual([12]);
      expect(calls).toBe(2);
    } finally {
      restarted.close();
    }
  });

  it("uses approved wall time for retry waiting and does not start an attempt after exhaustion", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-wall-time-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-wall-time-source-");
    let elapsedMs = 0;
    const baseTime = Date.UTC(2026, 7, 12, 8, 0, 0);
    const clock: Clock = {
      now: () => new Date(baseTime + elapsedMs).toISOString(),
    };
    let calls = 0;
    const waits: number[] = [];
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: {
        ...completingModel(() => undefined),
        generateResearchTurn: async () => {
          calls += 1;
          throw new InfrastructureFailureError("rate_limited", {
            retryAfterMs: 100,
          });
        },
      },
      clock,
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 3,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
      retryScheduler: {
        wait: async (delayMs) => {
          waits.push(delayMs);
          elapsedMs += delayMs;
        },
      },
    });
    try {
      const waiting = await runtime.createRun({
        question: "retry 是否遵守 wall time？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 4_096,
          maxTotalBytes: 4_096,
        },
        runBudget: { ...generousBudget(), maxWallTimeMs: 40 },
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试要求等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      const suspended = await runtime.advanceResearch({ runId: waiting.runId });
      expect(suspended.state).toMatchObject({
        type: "budget_exhausted",
        exhaustedDimension: "wall_time",
        remainingBudget: { wallTimeMs: 0 },
        operationAttempts: [expect.objectContaining({
          attemptNumber: 1,
          outcome: "retryable_failure",
        })],
      });
      expect(waits).toEqual([40]);
      expect(calls).toBe(1);
    } finally {
      runtime.close();
    }
  });

  it("persists an invalid Search Port result as an invariant failure", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-invariant-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-invariant-source-");
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: {
        ...completingModel(() => undefined),
        generateResearchTurn: async () => ({
          text: "搜索。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "search",
            name: "search_sources",
            input: { query: "canonical", maxResults: 1 },
          }],
        }),
      },
      sourceSearch: {
        search: async () => [{
          rootIndex: -1,
          relativePath: "journal.md",
          lineNumber: 0,
          lineText: "malformed",
        }],
      },
      clock: incrementingClock(),
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
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.bindingHash,
      });
      const failed = await runtime.advanceResearch({ runId: waiting.runId });
      expect(failed.state).toMatchObject({
        type: "failed",
        operationKind: "search_sources",
        failure: {
          category: "invariant_violation",
          code: "invalid_search_result",
        },
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.at(-1)).toMatchObject({
        type: "run_failed",
        operationKind: "search_sources",
        failureCategory: "invariant_violation",
        failureCode: "invalid_search_result",
      });
    } finally {
      runtime.close();
    }
  });

  it("recovers an interrupted search attempt under the same logical Tool Call", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-search-restart-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-search-restart-source-");
    let hookCalls = 0;
    let modelCalls = 0;
    let searchCalls = 0;
    const ids = sequentialIds();
    const clock = incrementingClock();
    const model: ModelPort = {
      ...completingModel(() => undefined),
      generateResearchTurn: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? {
              text: "搜索。",
              evidenceGaps: [],
              finishReason: "tool_calls",
              toolIntents: [{
                intentId: "search",
                name: "search_sources",
                input: { query: "canonical", maxResults: 1 },
              }],
            }
          : {
              text: "完成。",
              evidenceGaps: [],
              finishReason: "tool_calls",
              toolIntents: [{
                intentId: "complete",
                name: "complete_research",
                input: { unresolvedQuestions: [] },
              }],
            };
      },
    };
    const policy = {
      version: "retry-v1",
      modelMaxAttempts: 2,
      toolMaxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
    } as const;
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      sourceSearch: {
        search: async () => {
          searchCalls += 1;
          return [];
        },
      },
      clock,
      ids,
      retryPolicy: policy,
      researchLoopHooks: {
        afterOperationAttemptStarted: () => {
          hookCalls += 1;
          if (hookCalls === 2) throw new Error("模拟 search I/O 前中断");
        },
      },
    });
    const waiting = await createWaitingRun(first, sourceRoot);
    await first.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.bindingHash,
    });
    await expect(first.advanceResearch({ runId: waiting.runId }))
      .rejects.toMatchObject({ name: "ResearchLoopError" });
    const interrupted = await first.inspectRun({ runId: waiting.runId });
    expect(interrupted.state).toMatchObject({
      type: "researching",
      operationAttempts: [
        expect.objectContaining({ operationKind: "model_turn", outcome: "succeeded" }),
        expect.objectContaining({ operationKind: "search_sources", outcome: "in_progress" }),
      ],
    });
    expect(modelCalls).toBe(1);
    expect(searchCalls).toBe(0);
    first.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      sourceSearch: {
        search: async () => {
          searchCalls += 1;
          return [];
        },
      },
      clock,
      ids,
      retryScheduler: { wait: async () => undefined },
    });
    try {
      const completed = await restarted.advanceResearch({ runId: waiting.runId });
      if (completed.state.type !== "research_complete") {
        throw new Error("测试要求 research_complete 状态");
      }
      const attempts = completed.state.operationAttempts.filter(
        (attempt) => attempt.operationKind === "search_sources",
      );
      expect(attempts).toMatchObject([
        { attemptNumber: 1, outcome: "retryable_failure" },
        { attemptNumber: 2, outcome: "succeeded" },
      ]);
      expect(new Set(attempts.map((attempt) => attempt.toolCallId)).size).toBe(1);
      expect(modelCalls).toBe(2);
      expect(searchCalls).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("does not retry or expose an unknown permanent Model provider error", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-model-permanent-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-model-permanent-source-");
    let calls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: {
        ...completingModel(() => undefined),
        generateResearchTurn: async () => {
          calls += 1;
          throw new Error("secret provider payload");
        },
      },
      clock: incrementingClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 3,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
    });
    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.bindingHash,
      });
      const failed = await runtime.advanceResearch({ runId: waiting.runId });
      expect(failed.state).toMatchObject({
        type: "failed",
        failure: {
          category: "model_permanent",
          code: "model_generation_failed",
        },
      });
      expect(calls).toBe(1);
      expect(JSON.stringify(failed)).not.toContain("secret provider payload");
    } finally {
      runtime.close();
    }
  });
});

function retryReducerEvents(modelMaxAttempts = 1): ResearchRunEvent[] {
  const sourceScope = {
    roots: [{
      canonicalPath: "/approved",
      device: "1",
      inode: "2",
    }],
    exclusions: [],
    allowedExtensions: [".md"],
    maxFileBytes: 4_096,
    maxTotalBytes: 4_096,
  } as const;
  const budget = generousBudget();
  const planHash = "a".repeat(64);
  const policy = {
    version: "retry-v1",
    modelMaxAttempts,
    toolMaxAttempts: 2,
    baseDelayMs: 10,
    maxDelayMs: 100,
  } as const;
  const startedAt = "2026-08-12T08:00:01.000Z";
  const completedAt = "2026-08-12T08:00:01.005Z";
  const approvalBinding = createPlanApprovalBinding({
    question: "retry?",
    planHash,
    sourceScope,
    runBudget: budget,
    retryPolicy: policy,
  });
  return [
    {
      eventId: "event-001",
      runId: "run-reducer-retry",
      sequence: 1,
      type: "run_created",
      occurredAt: "2026-08-12T08:00:00.000Z",
      payload: {
        question: "retry?",
        sourceScope,
        runBudget: budget,
        retryPolicy: policy,
      },
    },
    {
      eventId: "event-002",
      runId: "run-reducer-retry",
      sequence: 2,
      type: "planning_started",
      occurredAt: "2026-08-12T08:00:00.000Z",
      payload: {},
    },
    {
      eventId: "event-003",
      runId: "run-reducer-retry",
      sequence: 3,
      type: "plan_proposed",
      occurredAt: "2026-08-12T08:00:00.000Z",
      payload: {
        planArtifact: {
          artifactId: `sha256:${planHash}`,
          sha256: planHash,
          mediaType: "application/json",
          byteLength: 2,
          relativePath: `artifacts/sha256/aa/${planHash}.json`,
        },
        approvalBinding,
      },
    },
    {
      eventId: "event-004",
      runId: "run-reducer-retry",
      sequence: 4,
      type: "plan_approved",
      occurredAt: "2026-08-12T08:00:00.000Z",
      payload: {
        approvalReceipt: {
          approvalId: "approval-001",
          kind: "plan",
          approvedBy: "user-command",
          approvedAt: "2026-08-12T08:00:00.000Z",
          ...approvalBinding,
        },
      },
    },
    {
      eventId: "event-005",
      runId: "run-reducer-retry",
      sequence: 5,
      type: "operation_attempt_started",
      occurredAt: startedAt,
      payload: {
        attempt: {
          attemptId: "attempt-001",
          operationId: "operation-001",
          operationKind: "model_turn",
          attemptNumber: 1,
          retryPolicy: policy,
          startedAt,
          outcome: "in_progress",
        },
      },
    },
    {
      eventId: "event-006",
      runId: "run-reducer-retry",
      sequence: 6,
      type: "operation_attempt_failed",
      occurredAt: completedAt,
      payload: {
        attempt: {
          attemptId: "attempt-001",
          operationId: "operation-001",
          operationKind: "model_turn",
          attemptNumber: 1,
          retryPolicy: policy,
          startedAt,
          outcome: "retry_exhausted",
          completedAt,
          durationMs: 5,
          failure: {
            category: "infrastructure_transient",
            code: "request_timeout",
          },
        },
      },
    },
    {
      eventId: "event-007",
      runId: "run-reducer-retry",
      sequence: 7,
      type: "run_retry_exhausted",
      occurredAt: completedAt,
      payload: {
        operationId: "operation-001",
        operationKind: "model_turn",
        attemptsUsed: 1,
        failure: {
          category: "infrastructure_transient",
          code: "request_timeout",
        },
      },
    },
  ];
}

function completingModel(onGenerate: () => void): ModelPort {
  return {
    proposePlan: async () => ({
      title: "验证 interrupted attempt",
      objectives: ["重启后安全恢复"],
      steps: [{ id: "step-001", description: "完成 generation" }],
    }),
    proposeLearningArtifact: async () => {
      throw new Error("测试不会生成 Learning Artifact");
    },
    generateResearchTurn: async () => {
      onGenerate();
      return {
        text: "重启后完成。",
        evidenceGaps: [],
        finishReason: "tool_calls",
        toolIntents: [{
          intentId: "complete",
          name: "complete_research",
          input: { unresolvedQuestions: [] },
        }],
      };
    },
  };
}

async function createWaitingRun(
  runtime: ResearchAgentRuntime,
  sourceRoot: string,
): Promise<WaitingRunIdentity> {
  const waiting = await runtime.createRun({
    question: "失败如何被安全分类？",
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
  return {
    runId: waiting.runId,
    bindingHash: waiting.state.approvalBinding.bindingHash,
    approvalBinding: waiting.state.approvalBinding,
  };
}

/** 测试推进已进入计划审批边界的最小 durable identity。 */
interface WaitingRunIdentity {
  /** 待审批 Research Run identity。 */
  readonly runId: string;
  /** 用户命令必须精确提交的计划审批 binding hash。 */
  readonly bindingHash: string;
  /** 等待状态中完整、可检查的计划审批边界。 */
  readonly approvalBinding: import("../../src/index.js").PlanApprovalBinding;
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

function incrementingClock(): Clock {
  let tick = 0;
  return {
    now: () => new Date(Date.UTC(2026, 7, 12, 8, 0, 0, tick++ * 5)).toISOString(),
  };
}

function sequentialIds(): IdGenerator {
  let event = 0;
  let toolCall = 0;
  let observation = 0;
  return {
    nextRunId: () => "run-retry-001",
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
