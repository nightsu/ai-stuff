import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ModelGenerationAbortedError,
  ResearchAgentRuntime,
  RunBusyError,
} from "../../src/index.js";
import type { ModelPort, ResearchPlan } from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("ResearchAgentRuntime durable Run Operations", () => {
  it("rejects a competing mutation for one Run while keeping reads and another Run available", async () => {
    const runtimeHome = await temporaryDirectory("run-operation-runtime-");
    const sourceRoot = await temporaryDirectory("run-operation-source-");
    let releaseFirstStream: (() => void) | undefined;
    let enterFirstStream: (() => void) | undefined;
    const firstStreamEntered = new Promise<void>((resolve) => {
      enterFirstStream = resolve;
    });
    const firstStreamReleased = new Promise<void>((resolve) => {
      releaseFirstStream = resolve;
    });
    let generation = 0;
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async (_view, options) => {
        generation += 1;
        if (generation === 1) {
          enterFirstStream?.();
          await Promise.race([
            firstStreamReleased,
            new Promise<never>((_resolve, reject) => {
              options?.abortSignal?.addEventListener(
                "abort",
                () => reject(new ModelGenerationAbortedError()),
                { once: true },
              );
            }),
          ]);
        }
        return {
          text: "完成。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: `complete-${generation}`,
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          }],
        };
      },
    };
    const first = ResearchAgentRuntime.open({ runtimeHome, model });
    const second = ResearchAgentRuntime.open({ runtimeHome, model });

    try {
      const firstRun = await createApprovedRun(first, sourceRoot);
      const secondRun = await createApprovedRun(first, sourceRoot);
      const advancingFirst = first.advanceResearch({ runId: firstRun });
      await firstStreamEntered;

      await expect(second.pauseRun({ runId: firstRun }))
        .rejects.toBeInstanceOf(RunBusyError);
      await expect(second.inspectRun({ runId: firstRun }))
        .resolves.toMatchObject({ runId: firstRun, state: { type: "researching" } });
      await expect(second.traceRun({ runId: firstRun }))
        .resolves.toMatchObject({ runId: firstRun });
      await expect(second.inspectRunOperation({ runId: firstRun }))
        .resolves.toMatchObject({
          lease: {
            runId: firstRun,
            kind: "advance_research",
          },
        });

      await expect(second.advanceResearch({ runId: secondRun }))
        .resolves.toMatchObject({ state: { type: "research_complete" } });

      releaseFirstStream?.();
      await expect(advancingFirst)
        .resolves.toMatchObject({ state: { type: "research_complete" } });
      await expect(second.inspectRunOperation({ runId: firstRun }))
        .resolves.toEqual({ lease: undefined, cancellationRequest: undefined });
    } finally {
      releaseFirstStream?.();
      first.close();
      second.close();
    }
  });

  it("heartbeats an active lease and consumes a cross-Runtime durable cancellation request", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-operation-runtime-");
    const sourceRoot = await temporaryDirectory("run-cancel-operation-source-");
    let enterStream: (() => void) | undefined;
    const streamEntered = new Promise<void>((resolve) => {
      enterStream = resolve;
    });
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async (_view, options) => {
        enterStream?.();
        await new Promise<void>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new ModelGenerationAbortedError()),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    };
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      operationLeaseDurationMs: 200,
      operationHeartbeatIntervalMs: 10,
    });
    const second = ResearchAgentRuntime.open({ runtimeHome, model });

    try {
      const runId = await createApprovedRun(first, sourceRoot);
      const advancing = first.advanceResearch({ runId });
      await streamEntered;
      const beforeHeartbeat = await second.inspectRunOperation({ runId });
      await delay(30);
      const afterHeartbeat = await second.inspectRunOperation({ runId });
      expect(afterHeartbeat.lease?.heartbeatAt)
        .not.toBe(beforeHeartbeat.lease?.heartbeatAt);

      const cancelling = second.cancelRun({ runId });
      await expect(advancing).rejects.toBeInstanceOf(ModelGenerationAbortedError);
      await expect(cancelling).resolves.toMatchObject({
        state: { type: "cancelled" },
      });
      await expect(second.inspectRunOperation({ runId })).resolves.toMatchObject({
        lease: undefined,
        cancellationRequest: {
          runId,
          consumedAt: expect.any(String),
          consumedByOperationId: expect.stringMatching(/^operation-/),
        },
      });
    } finally {
      first.close();
      second.close();
    }
  });

  it("takes over an expired lease and recovers only from the Run Journal", async () => {
    const runtimeHome = await temporaryDirectory("run-stale-operation-runtime-");
    const sourceRoot = await temporaryDirectory("run-stale-operation-source-");
    const [operationClock, setOperationTime] = controlledClock(
      "2026-08-12T10:00:00.000Z",
    );
    let interruptNextOperation = true;
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(),
      operationClock,
      operationLeaseDurationMs: 1_000,
      runOperationHooks: {
        afterLeaseAcquired: () => {
          if (!interruptNextOperation) return;
          interruptNextOperation = false;
          throw new Error("simulated owner crash");
        },
      },
    });
    const second = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(),
      operationClock,
      operationLeaseDurationMs: 1_000,
    });

    try {
      const runId = await createApprovedRun(second, sourceRoot);
      await expect(first.advanceResearch({ runId })).rejects.toThrow(
        "Run Operation 在 durable lease 后中断",
      );
      const stale = await second.inspectRunOperation({ runId });
      expect(stale.lease).toMatchObject({
        runId,
        kind: "advance_research",
        expiresAt: "2026-08-12T10:00:01.000Z",
      });
      await expect(second.pauseRun({ runId })).rejects.toBeInstanceOf(RunBusyError);

      setOperationTime("2026-08-12T10:00:02.000Z");
      await expect(second.pauseRun({ runId })).resolves.toMatchObject({
        lastEventSequence: 5,
        state: { type: "user_paused" },
      });
    } finally {
      first.close();
      second.close();
    }
  });

  it("fences an expired owner from committing after another operation takes over", async () => {
    const runtimeHome = await temporaryDirectory("run-fenced-operation-runtime-");
    const sourceRoot = await temporaryDirectory("run-fenced-operation-source-");
    const [operationClock, setOperationTime] = controlledClock(
      "2026-08-12T10:00:00.000Z",
    );
    let enterStream: (() => void) | undefined;
    let releaseStream: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterStream = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const model: ModelPort = {
      proposePlan: async () => learningPlan(),
      proposeLearningArtifact: async () => {
        throw new Error("测试不会生成 Learning Artifact");
      },
      generateResearchTurn: async () => {
        enterStream?.();
        await released;
        return {
          text: "迟到结果不得越过新 owner。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "late-complete",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          }],
        };
      },
    };
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      operationClock,
      operationLeaseDurationMs: 1_000,
      operationHeartbeatIntervalMs: 900,
    });
    const second = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      operationClock,
      operationLeaseDurationMs: 1_000,
      operationHeartbeatIntervalMs: 900,
    });

    try {
      const runId = await createApprovedRun(first, sourceRoot);
      const staleAdvance = first.advanceResearch({ runId });
      await entered;
      setOperationTime("2026-08-12T10:00:02.000Z");
      await expect(second.pauseRun({ runId })).resolves.toMatchObject({
        lastEventSequence: 5,
        state: { type: "user_paused" },
      });
      releaseStream?.();
      await expect(staleAdvance).rejects.toMatchObject({ name: "ResearchLoopError" });
      await expect(second.inspectRun({ runId })).resolves.toMatchObject({
        lastEventSequence: 5,
        state: { type: "user_paused" },
      });
    } finally {
      releaseStream?.();
      first.close();
      second.close();
    }
  });

  it("fences an expired owner before another operation takes over", async () => {
    const runtimeHome = await temporaryDirectory("run-expired-operation-runtime-");
    const sourceRoot = await temporaryDirectory("run-expired-operation-source-");
    const [operationClock, setOperationTime] = controlledClock(
      "2026-08-12T10:00:00.000Z",
    );
    let enterStream: (() => void) | undefined;
    let releaseStream: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterStream = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      operationClock,
      operationLeaseDurationMs: 1_000,
      operationHeartbeatIntervalMs: 900,
      model: {
        proposePlan: async () => learningPlan(),
        proposeLearningArtifact: async () => {
          throw new Error("测试不会生成 Learning Artifact");
        },
        generateResearchTurn: async () => {
          enterStream?.();
          await released;
          return {
            text: "租期外的迟到结果不得进入 Journal。",
            evidenceGaps: [],
            finishReason: "tool_calls",
            toolIntents: [{
              intentId: "expired-complete",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            }],
          };
        },
      },
    });

    try {
      const runId = await createApprovedRun(runtime, sourceRoot);
      const expiredAdvance = runtime.advanceResearch({ runId });
      await entered;
      setOperationTime("2026-08-12T10:00:02.000Z");
      releaseStream?.();

      await expect(expiredAdvance).rejects.toMatchObject({
        name: "ResearchLoopError",
      });
      await expect(runtime.inspectRun({ runId })).resolves.toMatchObject({
        lastEventSequence: 4,
        state: { type: "researching" },
      });
    } finally {
      releaseStream?.();
      runtime.close();
    }
  });

  it("keeps fencing an expired owner after same-Runtime takeover releases its lease", async () => {
    const runtimeHome = await temporaryDirectory("run-same-owner-takeover-runtime-");
    const sourceRoot = await temporaryDirectory("run-same-owner-takeover-source-");
    const [operationClock, setOperationTime] = controlledClock(
      "2026-08-12T10:00:00.000Z",
    );
    let enterStream: (() => void) | undefined;
    let releaseStream: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterStream = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      operationClock,
      operationLeaseDurationMs: 1_000,
      operationHeartbeatIntervalMs: 900,
      model: {
        proposePlan: async () => learningPlan(),
        proposeLearningArtifact: async () => {
          throw new Error("测试不会生成 Learning Artifact");
        },
        generateResearchTurn: async () => {
          enterStream?.();
          await released;
          return {
            text: "同进程旧 command 也不得失去 fencing。",
            evidenceGaps: [],
            finishReason: "tool_calls",
            toolIntents: [{
              intentId: "same-runtime-complete",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            }],
          };
        },
      },
    });

    try {
      const runId = await createApprovedRun(runtime, sourceRoot);
      const approved = await runtime.inspectRun({ runId });
      if (approved.state.type !== "researching") {
        throw new Error("测试夹具没有进入 researching");
      }
      const staleAdvance = runtime.advanceResearch({ runId });
      await entered;
      setOperationTime("2026-08-12T10:00:02.000Z");

      await expect(runtime.approvePlan({
        runId,
        bindingHash: approved.state.approvalReceipt.bindingHash,
      })).resolves.toMatchObject({ lastEventSequence: 4 });
      releaseStream?.();

      await expect(staleAdvance).rejects.toMatchObject({
        name: "ResearchLoopError",
      });
      await expect(runtime.inspectRun({ runId })).resolves.toMatchObject({
        lastEventSequence: 4,
        state: { type: "researching" },
      });
    } finally {
      releaseStream?.();
      runtime.close();
    }
  });

  it("takes over an expired same-Runtime owner to consume durable cancellation", async () => {
    const runtimeHome = await temporaryDirectory("run-expired-owner-cancel-runtime-");
    const sourceRoot = await temporaryDirectory("run-expired-owner-cancel-source-");
    const [operationClock, setOperationTime] = controlledClock(
      "2026-08-12T10:00:00.000Z",
    );
    let enterStream: (() => void) | undefined;
    let releaseStream: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterStream = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      operationClock,
      operationLeaseDurationMs: 1_000,
      operationHeartbeatIntervalMs: 900,
      model: {
        proposePlan: async () => learningPlan(),
        proposeLearningArtifact: async () => {
          throw new Error("测试不会生成 Learning Artifact");
        },
        generateResearchTurn: async () => {
          enterStream?.();
          await released;
          return {
            text: "过期 owner 返回时 Run 已被 durable 取消。",
            evidenceGaps: [],
            finishReason: "tool_calls",
            toolIntents: [{
              intentId: "expired-owner-complete",
              name: "complete_research",
              input: { unresolvedQuestions: [] },
            }],
          };
        },
      },
    });

    try {
      const runId = await createApprovedRun(runtime, sourceRoot);
      const staleAdvance = runtime.advanceResearch({ runId });
      await entered;
      setOperationTime("2026-08-12T10:00:02.000Z");

      await expect(runtime.cancelRun({ runId })).resolves.toMatchObject({
        lastEventSequence: 5,
        state: { type: "cancelled" },
      });
      releaseStream?.();
      await expect(staleAdvance).rejects.toMatchObject({
        name: "ResearchLoopError",
      });
      await expect(runtime.inspectRunOperation({ runId })).resolves.toMatchObject({
        lease: undefined,
        cancellationRequest: {
          consumedAt: expect.any(String),
          consumedByOperationId: expect.stringMatching(/^operation-/),
        },
      });
    } finally {
      releaseStream?.();
      runtime.close();
    }
  });

  it("consumes a durable cancellation request before the next mutation after the requester crashes", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-recovery-runtime-");
    const sourceRoot = await temporaryDirectory("run-cancel-recovery-source-");
    const requester = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(),
      runOperationHooks: {
        afterCancellationRequested: () => {
          throw new Error("simulated requester crash");
        },
      },
    });
    const recovering = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(),
    });

    try {
      const runId = await createApprovedRun(recovering, sourceRoot);
      await expect(requester.cancelRun({ runId })).rejects.toThrow(
        "Run Operation 在 durable cancellation request 后中断",
      );
      await expect(recovering.inspectRunOperation({ runId })).resolves.toMatchObject({
        lease: undefined,
        cancellationRequest: {
          runId,
        },
      });

      await expect(recovering.pauseRun({ runId })).resolves.toMatchObject({
        lastEventSequence: 5,
        state: { type: "cancelled" },
      });
      await expect(recovering.inspectRunOperation({ runId })).resolves.toMatchObject({
        lease: undefined,
        cancellationRequest: {
          consumedAt: expect.any(String),
          consumedByOperationId: expect.stringMatching(/^operation-/),
        },
      });
    } finally {
      requester.close();
      recovering.close();
    }
  });

  it("does not leave a pending cancellation request when completion wins the request race", async () => {
    const runtimeHome = await temporaryDirectory("run-cancel-terminal-race-");
    const sourceRoot = await temporaryDirectory("run-cancel-terminal-source-");
    let allowRequest: (() => void) | undefined;
    let requestPaused: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      requestPaused = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      allowRequest = resolve;
    });
    const setup = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(),
    });
    let runId: string;
    try {
      runId = await createApprovedRun(setup, sourceRoot);
      await setup.advanceResearch({ runId });
    } finally {
      setup.close();
    }
    const requester = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(),
      runOperationHooks: {
        beforeCancellationRequested: async () => {
          requestPaused?.();
          await allowed;
        },
      },
    });
    const publisher = ResearchAgentRuntime.open({
      runtimeHome,
      model: completionModel(),
    });

    try {
      // research_complete 不是 terminal；用 cancelled 作为“另一取消已先结算”的
      // race winner，证明请求事务会重读 canonical state 而非相信旧快照。
      const delayedCancel = requester.cancelRun({ runId });
      await paused;
      await publisher.cancelRun({ runId });
      allowRequest?.();
      await expect(delayedCancel).resolves.toMatchObject({
        state: { type: "cancelled" },
      });
      await expect(publisher.inspectRunOperation({ runId })).resolves.toMatchObject({
        lease: undefined,
        cancellationRequest: { consumedAt: expect.any(String) },
      });
    } finally {
      allowRequest?.();
      requester.close();
      publisher.close();
    }
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createApprovedRun(
  runtime: ResearchAgentRuntime,
  sourceRoot: string,
): Promise<string> {
  const waiting = await runtime.createRun({
    question: "如何保证同一 Run 只有一个 durable operation？",
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
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试夹具没有等待计划审批");
  }
  await runtime.approvePlan({
    runId: waiting.runId,
    bindingHash: waiting.state.approvalBinding.bindingHash,
  });
  return waiting.runId;
}

function learningPlan(): ResearchPlan {
  return {
    title: "Run Operation lease",
    objectives: ["验证同一 Run 的 mutation 串行化"],
    steps: [{ id: "lease", description: "获取并释放 durable lease" }],
  };
}

function completionModel(): ModelPort {
  return {
    proposePlan: async () => learningPlan(),
    proposeLearningArtifact: async () => {
      throw new Error("测试不会生成 Learning Artifact");
    },
    generateResearchTurn: async () => ({
      text: "完成。",
      evidenceGaps: [],
      finishReason: "tool_calls",
      toolIntents: [{
        intentId: "complete",
        name: "complete_research",
        input: { unresolvedQuestions: [] },
      }],
    }),
  };
}

function controlledClock(initial: string) {
  let current = initial;
  return [
    { now: () => current },
    (next: string) => {
      current = next;
    },
  ] as const;
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
