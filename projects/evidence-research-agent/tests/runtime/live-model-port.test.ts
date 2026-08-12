import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OpenAiCompatibleModelPort,
  ModelGenerationAbortedError,
  ResearchAgentRuntime,
  ResearchLoopError,
} from "../../src/index.js";
import type {
  AiSdkStreamPart,
  Clock,
  IdGenerator,
} from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("ResearchAgentRuntime live Model Port seam", () => {
  it("cancels a partial live plan without proposing or persisting it", async () => {
    const runtimeHome = await temporaryDirectory("live-plan-cancel-runtime-");
    const sourceRoot = await temporaryDirectory("live-plan-cancel-source-");
    const controller = new AbortController();
    const model = new OpenAiCompatibleModelPort(liveConfig("plan-secret"), {
      streamText: (options) => ({
        stream: (async function* () {
          yield { type: "text-delta", id: "text-1", text: "partial plan" };
          controller.abort();
          expect(options.abortSignal).toBe(controller.signal);
          yield { type: "abort", reason: "cancelled" };
        })(),
      }),
    });
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
    });

    try {
      await expect(
        runtime.createRun({
          question: "取消计划 generation 会怎样？",
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
          },
          abortSignal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(ModelGenerationAbortedError);

      const trace = await runtime.traceRun({ runId: "run-001" });
      expect(trace.finalState).toBe("planning");
      expect(trace.events.some((event) => event.type === "plan_proposed"))
        .toBe(false);
      expect(JSON.stringify(trace)).not.toContain("partial plan");
    } finally {
      runtime.close();
    }
  });

  it("cancels a partial live Learning Artifact without persisting a draft", async () => {
    const runtimeHome = await temporaryDirectory("live-draft-cancel-runtime-");
    const sourceRoot = await temporaryDirectory("live-draft-cancel-source-");
    const outputRoot = await temporaryDirectory("live-draft-cancel-output-");
    await writeFile(
      join(sourceRoot, "source.md"),
      "Run Journal 是 canonical history。\n",
      "utf8",
    );
    const controller = new AbortController();
    let generation = 0;
    const model = new OpenAiCompatibleModelPort(liveConfig("draft-secret"), {
      streamText: (options) => ({
        stream: generation++ === 0
          ? stream([
              {
                type: "tool-call",
                toolCallId: "plan-call",
                toolName: "submit_research_plan",
                input: {
                  title: "建立 Evidence",
                  objectives: ["形成可发布 Claim"],
                  steps: [{ id: "step-1", description: "读取来源" }],
                },
              },
              {
                type: "finish",
                finishReason: "tool-calls",
                totalUsage: usage(10, 5),
              },
            ])
          : (async function* () {
              yield { type: "text-delta", id: "text-1", text: "partial draft" };
              controller.abort();
              expect(options.abortSignal).toBe(controller.signal);
              yield { type: "abort", reason: "cancelled" };
            })(),
      }),
    });
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有进入 plan approval 等待态");
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
        throw new Error("测试夹具没有保持 researching");
      }
      const observation = read.state.sourceReadObservations[0];
      if (observation?.status !== "succeeded") {
        throw new Error("测试夹具没有形成成功来源 observation");
      }
      const evidenced = await runtime.recordEvidence({
        runId: waiting.runId,
        observationId: observation.observationId,
      });
      if (evidenced.state.type !== "researching") {
        throw new Error("测试夹具没有保持 researching");
      }
      const evidence = evidenced.state.evidenceRecords[0];
      if (evidence === undefined) throw new Error("测试夹具没有形成 Evidence");
      const claimed = await runtime.recordClaim({
        runId: waiting.runId,
        kind: "source_fact",
        text: "Run Journal 是 canonical history。",
        evidenceIds: [evidence.evidenceId],
      });

      await expect(
        runtime.proposeLearningArtifact({
          runId: waiting.runId,
          targetPath: join(outputRoot, "cancelled.md"),
          abortSignal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(ModelGenerationAbortedError);

      const projection = await runtime.inspectRun({ runId: waiting.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(claimed.lastEventSequence);
      expect(JSON.stringify(await runtime.traceRun({ runId: waiting.runId })))
        .not.toContain("partial draft");
    } finally {
      runtime.close();
    }
  });

  it("rejects a restarted live Model Port whose Experiment Identity changed", async () => {
    const runtimeHome = await temporaryDirectory("live-model-mismatch-runtime-");
    const sourceRoot = await temporaryDirectory("live-model-mismatch-source-");
    const originalModel = new OpenAiCompatibleModelPort(liveConfig("secret"), {
      streamText: () => ({
        stream: stream([
          {
            type: "tool-call",
            toolCallId: "plan-call",
            toolName: "submit_research_plan",
            input: {
              title: "冻结实验身份",
              objectives: ["拒绝重启时换模型"],
              steps: [{ id: "step-1", description: "推进 Research Loop" }],
            },
          },
          {
            type: "finish",
            finishReason: "tool-calls",
            totalUsage: usage(10, 5),
          },
        ]),
      }),
    });
    const original = ResearchAgentRuntime.open({
      runtimeHome,
      model: originalModel,
      clock: fixedClock(),
      ids: sequentialIds(),
    });
    const waiting = await createWaitingRun(original, sourceRoot);
    if (waiting.state.type !== "waiting_plan_approval") {
      throw new Error("测试夹具没有进入 plan approval 等待态");
    }
    await original.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.state.approvalBinding.bindingHash,
    });
    original.close();

    const changedModel = new OpenAiCompatibleModelPort({
      ...liveConfig("new-secret"),
      model: "different-model",
    }, {
      streamText: () => {
        throw new Error("身份不匹配时不应调用 provider");
      },
    });
    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model: changedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
    });
    try {
      await expect(restarted.advanceResearch({ runId: waiting.runId }))
        .rejects.toBeInstanceOf(ResearchLoopError);
      const projection = await restarted.inspectRun({ runId: waiting.runId });
      expect(projection.experimentIdentity?.model).toBe("research-model");
    } finally {
      restarted.close();
    }
  });

  it("commits normalized usage and Experiment Identity for a completed live Model Turn", async () => {
    const runtimeHome = await temporaryDirectory("live-model-success-runtime-");
    const sourceRoot = await temporaryDirectory("live-model-success-source-");
    let generation = 0;
    const model = new OpenAiCompatibleModelPort(
      liveConfig("success-secret"),
      {
        streamText: () => ({
          stream: generation++ === 0
            ? stream([
                {
                  type: "tool-call",
                  toolCallId: "plan-call",
                  toolName: "submit_research_plan",
                  input: {
                    title: "验证 usage",
                    objectives: ["持久化完整 generation usage"],
                    steps: [{ id: "step-1", description: "显式完成研究" }],
                  },
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  totalUsage: usage(12, 5),
                },
              ])
            : stream([
                { type: "text-delta", id: "text-1", text: "没有未决问题。" },
                {
                  type: "tool-call",
                  toolCallId: "complete-call",
                  toolName: "complete_research",
                  input: { unresolvedQuestions: [], evidenceGaps: [] },
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  totalUsage: {
                    ...usage(33, 9),
                    inputTokenDetails: { cacheReadTokens: 4 },
                    outputTokenDetails: { reasoningTokens: 3 },
                  },
                },
              ]),
        }),
      },
    );
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    });

    try {
      const waiting = await createWaitingRun(runtime, sourceRoot);
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有进入 plan approval 等待态");
      }
      expect(waiting.state.approvalBinding.experimentIdentityHash).toMatch(
        /^[a-f0-9]{64}$/,
      );
      const approved = await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      if (approved.state.type !== "researching") {
        throw new Error("测试夹具没有进入 researching");
      }
      expect(approved.state.approvalReceipt.experimentIdentityHash).toBe(
        waiting.state.approvalBinding.experimentIdentityHash,
      );
      const completed = await runtime.advanceResearch({ runId: waiting.runId });
      if (completed.state.type !== "research_complete") {
        throw new Error("live Model Turn 没有显式完成研究");
      }

      expect(completed.state.modelTurns[0]?.usage).toEqual({
        inputTokens: 33,
        outputTokens: 9,
        totalTokens: 42,
        cachedInputTokens: 4,
        reasoningTokens: 3,
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.experimentIdentity).toEqual(model.experimentIdentity);
      expect(JSON.stringify(trace)).not.toContain("success-secret");
    } finally {
      runtime.close();
    }
  });

  it("persists non-secret Experiment Identity and never commits a cancelled partial turn", async () => {
    const runtimeHome = await temporaryDirectory("live-model-runtime-");
    const sourceRoot = await temporaryDirectory("live-model-source-");
    const controller = new AbortController();
    const apiKey = "live-provider-secret";
    let generation = 0;
    const model = new OpenAiCompatibleModelPort(
      liveConfig(apiKey),
      {
        streamText: (options) => ({
          stream: generation++ === 0
            ? stream([
                {
                  type: "tool-call",
                  toolCallId: "plan-call",
                  toolName: "submit_research_plan",
                  input: {
                    title: "验证 live model 取消",
                    objectives: ["partial delta 不进入 Journal"],
                    steps: [{ id: "step-1", description: "生成下一 Research Tool intent" }],
                  },
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  totalUsage: usage(20, 8),
                },
              ])
            : (async function* () {
                yield { type: "text-delta", id: "text-1", text: "partial" };
                controller.abort();
                expect(options.abortSignal).toBe(controller.signal);
                yield { type: "abort", reason: "cancelled" };
              })(),
        }),
      },
    );
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      clock: fixedClock(),
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    });

    try {
      const waiting = await runtime.createRun({
        question: "取消流式 generation 会怎样？",
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
        },
      });
      expect(waiting.experimentIdentity).toEqual({
        provider: "local-openai",
        model: "research-model",
        adapterVersion: "adapter-v1",
        promptVersion: "prompt-v1",
        toolSchemaVersion: "tools-v1",
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试夹具没有进入 plan approval 等待态");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });

      await expect(
        runtime.advanceResearch({
          runId: waiting.runId,
          abortSignal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(ModelGenerationAbortedError);

      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.some((event) => event.type === "retry_attempt_started"))
        .toBe(true);
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "retry_attempt_failed",
          attemptOutcome: "permanent_failure",
          failureCategory: "model_permanent",
          failureCode: "model_generation_aborted",
        }),
      ]));
      expect(trace.events.some((event) => event.type === "model_turn_completed"))
        .toBe(false);
      expect(trace.events.some((event) => event.type === "run_failed")).toBe(false);
      expect(JSON.stringify(await runtime.inspectRun({ runId: waiting.runId })))
        .not.toContain(apiKey);
      expect(JSON.stringify(trace)).not.toContain(apiKey);
      runtime.close();

      const restarted = ResearchAgentRuntime.open({
        runtimeHome,
        model,
        clock: fixedClock(),
        ids: sequentialIds(100),
        retryPolicy: {
          version: "retry-v1",
          modelMaxAttempts: 2,
          toolMaxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      });
      try {
        const recovered = await restarted.inspectRun({ runId: waiting.runId });
        if (recovered.state.type !== "researching") {
          throw new Error("明确取消不应在 Issue #8 内终止整个 Run");
        }
        expect(recovered.state.retryAttempts.at(-1)).toMatchObject({
          outcome: "permanent_failure",
          failure: {
            category: "model_permanent",
            code: "model_generation_aborted",
          },
        });
      } finally {
        restarted.close();
      }
    } finally {
      runtime.close();
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
  return runtime.createRun({
    question: "live model 如何形成 canonical turn？",
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
    },
  });
}

function liveConfig(apiKey: string) {
  return {
    provider: "local-openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey,
    model: "research-model",
    adapterVersion: "adapter-v1",
    promptVersion: "prompt-v1",
    toolSchemaVersion: "tools-v1",
  } as const;
}

async function* stream(
  parts: readonly AiSdkStreamPart[],
): AsyncGenerator<AiSdkStreamPart> {
  for (const part of parts) yield part;
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: { cacheReadTokens: 0 },
    outputTokenDetails: { reasoningTokens: 0 },
  };
}

function fixedClock(): Clock {
  return { now: () => "2026-08-12T09:00:00.000Z" };
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
