import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPlanApprovalBinding,
  formatRunTrace,
  InfrastructureFailureError,
  ResearchAgentRuntime,
  ResearchLoopError,
} from "../../src/index.js";
import type {
  Clock,
  IdGenerator,
  ModelPort,
  ModelView,
  RetryPolicy,
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
  it("terminally closes default plan postprocessing failure and never resamples after restart", async () => {
    const runtimeHome = await createTemporaryDirectory("default-plan-postprocess-runtime-");
    const sourceRoot = await createTemporaryDirectory("default-plan-postprocess-source-");
    const ids = sequentialIds();
    const clock = incrementingClock();
    let planCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => {
        planCalls += 1;
        return {
          title: "默认单次计划",
          objectives: ["后处理失败不得重采样"],
          steps: [{ id: "step-1", description: "提交 durable attempt" }],
        };
      },
      proposeLearningArtifact: async () => {
        throw new Error("测试不生成 artifact");
      },
    };
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
      researchLoopHooks: {
        beforePlanProposalJournalAppend: () => {
          throw new Error("simulated plan journal failure");
        },
      },
    });
    await expect(first.createRun({
      question: "默认计划后处理失败如何恢复？",
      sourceScope: {
        roots: [sourceRoot],
        exclusions: [],
        allowedExtensions: [".md"],
        maxFileBytes: 4_096,
        maxTotalBytes: 4_096,
      },
      runBudget: generousBudget(),
    })).rejects.toBeInstanceOf(ResearchLoopError);
    const database = new Database(join(runtimeHome, "runtime.sqlite"));
    const row = database.prepare("SELECT run_id AS runId FROM runs").get() as {
      /** 后处理失败后仍可定位的 durable Run identity。 */
      readonly runId: string;
    };
    database.close();
    await expect(first.inspectRun({ runId: row.runId })).resolves.toMatchObject({
      state: {
        type: "failed",
        retrySequenceKind: "plan_generation",
        failure: {
          category: "invariant_violation",
          code: "plan_persistence_failed",
        },
        retryAttempts: [expect.objectContaining({ outcome: "succeeded" })],
      },
    });
    first.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
    });
    try {
      await expect(restarted.resumeRun({ runId: row.runId })).rejects.toThrow();
      expect(planCalls).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("persists plan generation started before provider I/O and resumes the same sequence after restart", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-plan-restart-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-plan-restart-source-");
    const policy = {
      version: "retry-plan-restart-v1",
      modelMaxAttempts: 3,
      toolMaxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
    } as const;
    const ids = sequentialIds();
    const clock = incrementingClock();
    let interrupt = true;
    let planCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => {
        planCalls += 1;
        return {
          title: "恢复计划生成",
          objectives: ["重启后沿同一 Retry Sequence 继续"],
          steps: [{ id: "step-1", description: "恢复 interrupted attempt" }],
        };
      },
      proposeLearningArtifact: async () => {
        throw new Error("测试不生成 artifact");
      },
    };
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
      retryPolicy: policy,
      retryScheduler: { wait: async () => undefined },
      researchLoopHooks: {
        afterPlanRetryAttemptStarted: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟 plan provider I/O 前中断");
        },
      },
    });

    await expect(first.createRun({
      question: "计划 generation 中断后如何恢复？",
      sourceScope: {
        roots: [sourceRoot],
        exclusions: [],
        allowedExtensions: [".md"],
        maxFileBytes: 4_096,
        maxTotalBytes: 4_096,
      },
      runBudget: generousBudget(),
    })).rejects.toThrow();
    const database = new Database(join(runtimeHome, "runtime.sqlite"));
    const runId = database.prepare("SELECT run_id AS runId FROM runs").get() as {
      /** 创建流程中断后仍由 SQLite 保留的 Research Run identity。 */
      runId: string;
    };
    database.close();
    expect(planCalls).toBe(0);
    const interrupted = await first.inspectRun({ runId: runId.runId });
    expect(interrupted.state).toMatchObject({
      type: "planning",
      retryAttempts: [expect.objectContaining({
        retrySequenceKind: "plan_generation",
        attemptNumber: 1,
        outcome: "in_progress",
      })],
    });
    first.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
      retryPolicy: policy,
      retryScheduler: { wait: async () => undefined },
    });
    try {
      const waiting = await restarted.resumeRun({ runId: runId.runId });
      expect(waiting.state.type).toBe("waiting_plan_approval");
      expect(planCalls).toBe(1);
      const trace = await restarted.traceRun({ runId: runId.runId });
      const planAttempts = trace.events.filter((event) =>
        event.retrySequenceKind === "plan_generation"
      );
      expect(planAttempts).toEqual([
        expect.objectContaining({
          type: "retry_attempt_started",
          attemptNumber: 1,
          attemptOutcome: "in_progress",
        }),
        expect.objectContaining({
          type: "retry_attempt_failed",
          attemptNumber: 1,
          attemptOutcome: "retryable_failure",
          failureCode: "plan_generation_interrupted",
        }),
        expect.objectContaining({
          type: "retry_attempt_started",
          attemptNumber: 2,
          attemptOutcome: "in_progress",
        }),
        expect.objectContaining({
          type: "plan_proposed",
          attemptNumber: 2,
          attemptOutcome: "succeeded",
        }),
      ]);
      expect(new Set(planAttempts.map((event) => event.retrySequenceId)).size).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("retries transient plan generation and records each physical attempt", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-plan-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-plan-source-");
    let planCalls = 0;
    const waits: number[] = [];
    const model: ModelPort = {
      proposePlan: async () => {
        planCalls += 1;
        if (planCalls === 1) {
          throw new InfrastructureFailureError("rate_limited", {
            retryAfterMs: 75,
          });
        }
        return {
          title: "重试计划生成",
          objectives: ["让 planning failure 可恢复且可审计"],
          steps: [{ id: "step-1", description: "生成 exact plan" }],
        };
      },
      proposeLearningArtifact: async () => {
        throw new Error("测试不生成 artifact");
      },
    };
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 3,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
      },
      retryScheduler: {
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    });

    try {
      const waiting = await runtime.createRun({
        question: "计划生成如何重试？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 4_096,
          maxTotalBytes: 4_096,
        },
        runBudget: generousBudget(),
      });
      expect(waiting.state.type).toBe("waiting_plan_approval");
      expect(planCalls).toBe(2);
      expect(waits).toEqual([75]);
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "retry_attempt_failed",
          retrySequenceKind: "plan_generation",
          attemptNumber: 1,
          attemptOutcome: "retryable_failure",
        }),
        expect.objectContaining({
          type: "plan_proposed",
          retrySequenceKind: "plan_generation",
          attemptNumber: 2,
          attemptOutcome: "succeeded",
        }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it("terminally closes an invalid completed plan and never resamples it after restart", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-plan-invalid-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-plan-invalid-source-");
    const ids = sequentialIds();
    const clock = incrementingClock();
    let planCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => {
        planCalls += 1;
        return {
          title: "invalid plan",
          objectives: [],
          steps: [],
        } as never;
      },
      proposeLearningArtifact: async () => {
        throw new Error("测试不生成 artifact");
      },
    };
    const retryPolicy = {
      version: "retry-plan-invalid-v1",
      modelMaxAttempts: 3,
      toolMaxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
    } as const;
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
      retryPolicy,
    });
    await expect(first.createRun({
      question: "无效计划是否会被重采样？",
      sourceScope: {
        roots: [sourceRoot],
        exclusions: [],
        allowedExtensions: [".md"],
        maxFileBytes: 4_096,
        maxTotalBytes: 4_096,
      },
      runBudget: generousBudget(),
    })).rejects.toThrow();
    const database = new Database(join(runtimeHome, "runtime.sqlite"));
    const row = database.prepare("SELECT run_id AS runId FROM runs").get() as {
      /** schema-invalid planning 后仍可从 durable store 定位的 Run identity。 */
      readonly runId: string;
    };
    database.close();
    await expect(first.inspectRun({ runId: row.runId })).resolves.toMatchObject({
      state: {
        type: "failed",
        retrySequenceKind: "plan_generation",
        failure: { category: "model_contract", code: "invalid_research_plan" },
        retryAttempts: [expect.objectContaining({
          attemptNumber: 1,
          outcome: "permanent_failure",
        })],
      },
    });
    first.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
      retryPolicy,
    });
    try {
      await expect(restarted.resumeRun({ runId: row.runId })).rejects.toThrow();
      expect(planCalls).toBe(1);
      const trace = await restarted.traceRun({ runId: row.runId });
      expect(trace.events.slice(-2)).toEqual([
        expect.objectContaining({
          type: "retry_attempt_failed",
          attemptOutcome: "permanent_failure",
          failureCode: "invalid_research_plan",
        }),
        expect.objectContaining({
          type: "run_failed",
          retrySequenceKind: "plan_generation",
          failureCode: "invalid_research_plan",
        }),
      ]);
    } finally {
      restarted.close();
    }
  });

  it("persists a permanent planning provider failure as a terminal Run", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-plan-permanent-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-plan-permanent-source-");
    let planCalls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: {
        proposePlan: async () => {
          planCalls += 1;
          throw new Error("secret planning provider payload");
        },
        proposeLearningArtifact: async () => {
          throw new Error("测试不生成 artifact");
        },
      },
      ids: sequentialIds(),
      clock: incrementingClock(),
      retryPolicy: {
        version: "retry-plan-permanent-v1",
        modelMaxAttempts: 3,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
      },
    });
    try {
      await expect(runtime.createRun({
        question: "永久 planning failure 如何结算？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 4_096,
          maxTotalBytes: 4_096,
        },
        runBudget: generousBudget(),
      })).rejects.toThrow();
      const database = new Database(join(runtimeHome, "runtime.sqlite"));
      const row = database.prepare("SELECT run_id AS runId FROM runs").get() as {
        /** provider permanent failure 后保留的 Research Run identity。 */
        readonly runId: string;
      };
      database.close();
      const failed = await runtime.inspectRun({ runId: row.runId });
      expect(failed.state).toMatchObject({
        type: "failed",
        retrySequenceKind: "plan_generation",
        failure: { category: "model_permanent", code: "model_generation_failed" },
        retryAttempts: [expect.objectContaining({ outcome: "permanent_failure" })],
      });
      expect(planCalls).toBe(1);
      expect(JSON.stringify(failed)).not.toContain("secret planning provider payload");
    } finally {
      runtime.close();
    }
  });

  it("retries transient Learning Artifact proposal without duplicating the logical proposal", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-artifact-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-artifact-source-");
    const outputRoot = await createTemporaryDirectory("retry-artifact-output-");
    await writeFile(
      join(sourceRoot, "journal.md"),
      "Run Journal 是 canonical history。\n",
      "utf8",
    );
    let proposalCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => ({
        title: "形成可发布 Claim",
        objectives: ["验证 artifact proposal retry"],
        steps: [{ id: "step-1", description: "读取 journal.md" }],
      }),
      proposeLearningArtifact: async (request) => {
        proposalCalls += 1;
        if (proposalCalls === 1) {
          throw new InfrastructureFailureError("service_unavailable");
        }
        return {
          title: "可恢复 draft",
          summary: "瞬时失败不会产生第二个逻辑 draft。",
          claimIds: [request.claims[0]?.claimId ?? "missing-claim"],
        };
      },
    };
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model,
      evaluator: {
        identity: {
          provider: "scripted",
          model: "scripted-evaluator",
          promptVersion: "evaluator-v1",
        },
        reviewClaims: async (request) => ({
          verdicts: request.claims.map((claim) => ({
            claimId: claim.claimId,
            verdict: "supported" as const,
          })),
        }),
      },
      retryPolicy: {
        version: "retry-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 5,
        maxDelayMs: 20,
      },
      retryScheduler: { wait: async () => undefined },
    });

    try {
      const waiting = await runtime.createRun({
        question: "Artifact proposal 如何安全重试？",
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
      const read = await runtime.readSource({
        runId: waiting.runId,
        request: {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        },
      });
      if (read.state.type !== "researching") throw new Error("需要 researching");
      const observation = read.state.sourceReadObservations[0];
      if (observation?.status !== "succeeded") throw new Error("需要 read success");
      const evidenced = await runtime.recordEvidence({
        runId: waiting.runId,
        observationId: observation.observationId,
      });
      if (evidenced.state.type !== "researching") throw new Error("需要 Evidence");
      const evidence = evidenced.state.evidenceRecords[0];
      if (evidence === undefined) throw new Error("需要 Evidence Record");
      await runtime.recordClaim({
        runId: waiting.runId,
        kind: "source_fact",
        text: "Run Journal 是 canonical history。",
        evidenceIds: [evidence.evidenceId],
      });
      const draft = await runtime.proposeLearningArtifact({
        runId: waiting.runId,
        targetPath: join(outputRoot, "report.md"),
      });
      expect(draft.state.type).toBe("waiting_publication_approval");
      expect(proposalCalls).toBe(2);
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.filter((event) =>
        event.retrySequenceKind === "artifact_proposal"
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "retry_attempt_failed",
          attemptNumber: 1,
          attemptOutcome: "retryable_failure",
        }),
        expect.objectContaining({
          type: "learning_artifact_draft_proposed",
          attemptNumber: 2,
          attemptOutcome: "succeeded",
        }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it("recovers an interrupted Artifact proposal after restart without replaying the interrupted I/O", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-artifact-restart-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-artifact-restart-source-");
    const outputRoot = await createTemporaryDirectory("retry-artifact-restart-output-");
    await writeFile(
      join(sourceRoot, "journal.md"),
      "Run Journal 是 canonical history。\n",
      "utf8",
    );
    const policy = {
      version: "retry-artifact-restart-v1",
      modelMaxAttempts: 3,
      toolMaxAttempts: 2,
      baseDelayMs: 5,
      maxDelayMs: 20,
    } as const;
    const ids = sequentialIds();
    const clock = incrementingClock();
    let interrupt = true;
    let proposalCalls = 0;
    const model: ModelPort = {
      proposePlan: async () => ({
        title: "恢复 Artifact proposal",
        objectives: ["重启后不重放 interrupted I/O"],
        steps: [{ id: "step-1", description: "形成 exact draft" }],
      }),
      proposeLearningArtifact: async (request) => {
        proposalCalls += 1;
        return {
          title: "恢复后的 draft",
          summary: "Interrupted attempt 已闭合后才执行新 attempt。",
          claimIds: [request.claims[0]?.claimId ?? "missing-claim"],
        };
      },
    };
    const evaluator = {
      identity: {
        provider: "scripted",
        model: "scripted-evaluator",
        promptVersion: "evaluator-v1",
      },
      reviewClaims: async (request: import("../../src/index.js").EvaluatorReviewRequest) => ({
        verdicts: request.claims.map((claim) => ({
          claimId: claim.claimId,
          verdict: "supported" as const,
        })),
      }),
    };
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model,
      evaluator,
      ids,
      clock,
      retryPolicy: policy,
      retryScheduler: { wait: async () => undefined },
      researchLoopHooks: {
        afterArtifactRetryAttemptStarted: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟 Artifact provider I/O 前中断");
        },
      },
    });
    const waiting = await first.createRun({
      question: "Artifact proposal 中断后如何恢复？",
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
    await first.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.state.approvalBinding.bindingHash,
    });
    const read = await first.readSource({
      runId: waiting.runId,
      request: {
        rootIndex: 0,
        relativePath: "journal.md",
        startLine: 1,
        endLine: 1,
      },
    });
    if (read.state.type !== "researching") throw new Error("需要 researching");
    const observation = read.state.sourceReadObservations[0];
    if (observation?.status !== "succeeded") throw new Error("需要 read success");
    const evidenced = await first.recordEvidence({
      runId: waiting.runId,
      observationId: observation.observationId,
    });
    if (evidenced.state.type !== "researching") throw new Error("需要 Evidence");
    const evidence = evidenced.state.evidenceRecords[0];
    if (evidence === undefined) throw new Error("需要 Evidence Record");
    await first.recordClaim({
      runId: waiting.runId,
      kind: "source_fact",
      text: "Run Journal 是 canonical history。",
      evidenceIds: [evidence.evidenceId],
    });
    const targetPath = join(outputRoot, "restart.md");
    await expect(first.proposeLearningArtifact({
      runId: waiting.runId,
      targetPath,
    })).rejects.toMatchObject({ name: "LearningArtifactDraftError" });
    expect(proposalCalls).toBe(0);
    const interrupted = await first.inspectRun({ runId: waiting.runId });
    expect(interrupted.state).toMatchObject({
      type: "researching",
      retryAttempts: [expect.objectContaining({
        retrySequenceKind: "artifact_proposal",
        attemptNumber: 1,
        outcome: "in_progress",
      })],
    });
    first.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model,
      evaluator,
      ids,
      clock,
      retryPolicy: policy,
      retryScheduler: { wait: async () => undefined },
    });
    try {
      const draft = await restarted.proposeLearningArtifact({
        runId: waiting.runId,
        targetPath,
      });
      expect(draft.state.type).toBe("waiting_publication_approval");
      expect(proposalCalls).toBe(1);
      const trace = await restarted.traceRun({ runId: waiting.runId });
      const attempts = trace.events.filter((event) =>
        event.retrySequenceKind === "artifact_proposal"
      );
      expect(attempts).toEqual([
        expect.objectContaining({
          type: "retry_attempt_started",
          attemptNumber: 1,
          attemptOutcome: "in_progress",
        }),
        expect.objectContaining({
          type: "retry_attempt_failed",
          attemptNumber: 1,
          attemptOutcome: "retryable_failure",
          failureCode: "artifact_proposal_interrupted",
        }),
        expect.objectContaining({
          type: "retry_attempt_started",
          attemptNumber: 2,
          attemptOutcome: "in_progress",
        }),
        expect.objectContaining({
          type: "learning_artifact_draft_proposed",
          attemptNumber: 2,
          attemptOutcome: "succeeded",
        }),
      ]);
      expect(new Set(attempts.map((event) => event.retrySequenceId)).size).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("suspends artifact proposal after the frozen retry limit and rejects a fresh sequence", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-artifact-exhausted-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-artifact-exhausted-source-");
    const outputRoot = await createTemporaryDirectory("retry-artifact-exhausted-output-");
    await writeFile(
      join(sourceRoot, "journal.md"),
      "Run Journal 是 canonical history。\n",
      "utf8",
    );
    let proposalCalls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model: {
        proposePlan: async () => ({
          title: "验证 proposal exhaustion",
          objectives: ["达到冻结上限后暂停"],
          steps: [{ id: "step-1", description: "形成 Claim" }],
        }),
        proposeLearningArtifact: async () => {
          proposalCalls += 1;
          throw new InfrastructureFailureError("service_unavailable");
        },
      },
      retryPolicy: {
        version: "retry-artifact-exhausted-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 5,
        maxDelayMs: 20,
      },
      retryScheduler: { wait: async () => undefined },
    });
    try {
      const waiting = await runtime.createRun({
        question: "Artifact proposal 耗尽后会怎样？",
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
      const read = await runtime.readSource({
        runId: waiting.runId,
        request: {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        },
      });
      if (read.state.type !== "researching") throw new Error("需要 researching");
      const observation = read.state.sourceReadObservations[0];
      if (observation?.status !== "succeeded") throw new Error("需要 read success");
      const evidenced = await runtime.recordEvidence({
        runId: waiting.runId,
        observationId: observation.observationId,
      });
      if (evidenced.state.type !== "researching") throw new Error("需要 Evidence");
      const evidence = evidenced.state.evidenceRecords[0];
      if (evidence === undefined) throw new Error("需要 Evidence Record");
      await runtime.recordClaim({
        runId: waiting.runId,
        kind: "source_fact",
        text: "Run Journal 是 canonical history。",
        evidenceIds: [evidence.evidenceId],
      });
      const targetPath = join(outputRoot, "exhausted.md");
      await expect(runtime.proposeLearningArtifact({
        runId: waiting.runId,
        targetPath,
      })).rejects.toThrow();
      const suspended = await runtime.inspectRun({ runId: waiting.runId });
      expect(suspended.state).toMatchObject({
        type: "retry_exhausted",
        retrySequenceKind: "artifact_proposal",
        attemptsUsed: 2,
      });
      await expect(runtime.proposeLearningArtifact({
        runId: waiting.runId,
        targetPath,
      })).rejects.toMatchObject({ name: "IllegalLearningArtifactStateError" });
      expect(proposalCalls).toBe(2);
    } finally {
      runtime.close();
    }
  });

  it("closes Artifact proposal exhaustion from research_complete without losing completion", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-artifact-complete-exhausted-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-artifact-complete-exhausted-source-");
    const outputRoot = await createTemporaryDirectory("retry-artifact-complete-exhausted-output-");
    await writeFile(join(sourceRoot, "journal.md"), "Run Journal 是 canonical history。\n", "utf8");
    let proposalCalls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model: {
        proposePlan: async () => ({
          title: "完成后 proposal exhaustion",
          objectives: ["保留 research completion"],
          steps: [{ id: "step-1", description: "形成 Claim 并完成研究" }],
        }),
        proposeLearningArtifact: async () => {
          proposalCalls += 1;
          throw new InfrastructureFailureError("service_unavailable");
        },
        generateResearchTurn: async () => ({
          text: "证据已齐，完成研究。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "complete-artifact-exhaustion",
            name: "complete_research",
            input: { unresolvedQuestions: ["provider unavailable"] },
          }],
        }),
      },
      retryPolicy: {
        version: "retry-artifact-complete-exhausted-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 5,
        maxDelayMs: 20,
      },
      retryScheduler: { wait: async () => undefined },
      ids: sequentialIds(),
      clock: incrementingClock(),
    });
    try {
      const runId = await createClaimedRun(runtime, sourceRoot);
      await expect(runtime.advanceResearch({ runId })).resolves.toMatchObject({
        state: { type: "research_complete" },
      });
      await expect(runtime.proposeLearningArtifact({
        runId,
        targetPath: join(outputRoot, "exhausted.md"),
      })).rejects.toThrow();
      await expect(runtime.inspectRun({ runId })).resolves.toMatchObject({
        state: {
          type: "retry_exhausted",
          retrySequenceKind: "artifact_proposal",
          attemptsUsed: 2,
          completion: { unresolvedQuestions: ["provider unavailable"] },
          retryAttempts: expect.arrayContaining([
            expect.objectContaining({ outcome: "retryable_failure" }),
            expect.objectContaining({ outcome: "retry_exhausted" }),
          ]),
        },
      });
      expect(proposalCalls).toBe(2);
    } finally {
      runtime.close();
    }
  });

  it("closes a permanent Artifact proposal failure from research_complete", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-artifact-complete-permanent-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-artifact-complete-permanent-source-");
    const outputRoot = await createTemporaryDirectory("retry-artifact-complete-permanent-output-");
    await writeFile(join(sourceRoot, "journal.md"), "Run Journal 是 canonical history。\n", "utf8");
    let proposalCalls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model: {
        proposePlan: async () => ({
          title: "完成后 permanent proposal failure",
          objectives: ["进入明确 failed 终态"],
          steps: [{ id: "step-1", description: "形成 Claim 并完成研究" }],
        }),
        proposeLearningArtifact: async () => {
          proposalCalls += 1;
          throw new Error("secret artifact provider payload");
        },
        generateResearchTurn: async () => ({
          text: "完成研究。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "complete-artifact-permanent",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          }],
        }),
      },
      retryPolicy: {
        version: "retry-artifact-complete-permanent-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 5,
        maxDelayMs: 20,
      },
      ids: sequentialIds(),
      clock: incrementingClock(),
    });
    try {
      const runId = await createClaimedRun(runtime, sourceRoot);
      await runtime.advanceResearch({ runId });
      await expect(runtime.proposeLearningArtifact({
        runId,
        targetPath: join(outputRoot, "failed.md"),
      })).rejects.toThrow();
      const failed = await runtime.inspectRun({ runId });
      expect(failed.state).toMatchObject({
        type: "failed",
        retrySequenceKind: "artifact_proposal",
        completion: { unresolvedQuestions: [] },
        failure: { category: "model_permanent", code: "model_generation_failed" },
        retryAttempts: expect.arrayContaining([
          expect.objectContaining({ outcome: "permanent_failure" }),
        ]),
      });
      expect(proposalCalls).toBe(1);
      expect(JSON.stringify(failed)).not.toContain("secret artifact provider payload");
    } finally {
      runtime.close();
    }
  });

  it("suspends before the next Artifact proposal attempt when backoff exhausts wall time", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-artifact-wall-time-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-artifact-wall-time-source-");
    const outputRoot = await createTemporaryDirectory("retry-artifact-wall-time-output-");
    await writeFile(join(sourceRoot, "journal.md"), "Run Journal 是 canonical history。\n", "utf8");
    let elapsedMs = 0;
    let proposalCalls = 0;
    const clock: Clock = {
      now: () => new Date(Date.UTC(2026, 7, 12, 8, 0, 0, elapsedMs)).toISOString(),
    };
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model: {
        proposePlan: async () => ({
          title: "Artifact backoff budget",
          objectives: ["下一 provider I/O 前暂停"],
          steps: [{ id: "step-1", description: "形成 Claim" }],
        }),
        proposeLearningArtifact: async (request) => {
          proposalCalls += 1;
          if (proposalCalls === 1) {
            throw new InfrastructureFailureError("rate_limited", {
              retryAfterMs: 10,
            });
          }
          return {
            title: "不应生成",
            summary: "第二次 provider I/O 不应发生。",
            claimIds: [request.claims[0]?.claimId ?? "missing"],
          };
        },
      },
      retryPolicy: {
        version: "retry-artifact-wall-time-v1",
        modelMaxAttempts: 3,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 20,
      },
      retryScheduler: {
        wait: async (delayMs) => {
          elapsedMs += delayMs;
        },
      },
      ids: sequentialIds(),
      clock,
    });
    try {
      const waiting = await runtime.createRun({
        question: "Artifact retry backoff 是否服从 wall-time？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 4_096,
          maxTotalBytes: 4_096,
        },
        runBudget: { ...generousBudget(), maxWallTimeMs: 5 },
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
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        },
      });
      if (read.state.type !== "researching") throw new Error("需要 researching");
      const observation = read.state.sourceReadObservations[0];
      if (observation?.status !== "succeeded") throw new Error("需要 read success");
      const evidenced = await runtime.recordEvidence({
        runId: waiting.runId,
        observationId: observation.observationId,
      });
      if (evidenced.state.type !== "researching") throw new Error("需要 Evidence");
      const evidence = evidenced.state.evidenceRecords[0];
      if (evidence === undefined) throw new Error("需要 Evidence Record");
      await runtime.recordClaim({
        runId: waiting.runId,
        kind: "source_fact",
        text: "Run Journal 是 canonical history。",
        evidenceIds: [evidence.evidenceId],
      });
      await expect(runtime.proposeLearningArtifact({
        runId: waiting.runId,
        targetPath: join(outputRoot, "wall-time.md"),
      })).rejects.toThrow();
      await expect(runtime.inspectRun({ runId: waiting.runId })).resolves.toMatchObject({
        state: {
          type: "budget_exhausted",
          exhaustedDimension: "wall_time",
          retryAttempts: [expect.objectContaining({
            retrySequenceKind: "artifact_proposal",
            outcome: "retryable_failure",
          })],
        },
      });
      expect(proposalCalls).toBe(1);
      expect(elapsedMs).toBe(5);
    } finally {
      runtime.close();
    }
  });

  it("closes a successful but schema-invalid Artifact proposal attempt with the repair fact", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-artifact-invalid-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-artifact-invalid-source-");
    const outputRoot = await createTemporaryDirectory("retry-artifact-invalid-output-");
    await writeFile(
      join(sourceRoot, "journal.md"),
      "Run Journal 是 canonical history。\n",
      "utf8",
    );
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      outputRoot,
      model: {
        proposePlan: async () => ({
          title: "验证无效 proposal attempt",
          objectives: ["完成 attempt 不能被误报为 interrupted"],
          steps: [{ id: "step-1", description: "形成 Claim" }],
        }),
        proposeLearningArtifact: async () => ({
          title: "无效 draft",
          summary: "第一句。第二句。",
          claimIds: ["missing-claim"],
        }),
        generateResearchTurn: async () => ({
          text: "证据已齐，显式完成研究。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "complete-invalid-proposal",
            name: "complete_research",
            input: { unresolvedQuestions: [] },
          }],
        }),
      },
      retryPolicy: {
        version: "retry-artifact-invalid-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 5,
        maxDelayMs: 20,
      },
      retryScheduler: { wait: async () => undefined },
    });
    try {
      const waiting = await runtime.createRun({
        question: "无效 Artifact proposal 如何计账？",
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
      const read = await runtime.readSource({
        runId: waiting.runId,
        request: {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        },
      });
      if (read.state.type !== "researching") throw new Error("需要 researching");
      const observation = read.state.sourceReadObservations[0];
      if (observation?.status !== "succeeded") throw new Error("需要 read success");
      const evidenced = await runtime.recordEvidence({
        runId: waiting.runId,
        observationId: observation.observationId,
      });
      if (evidenced.state.type !== "researching") throw new Error("需要 Evidence");
      const evidence = evidenced.state.evidenceRecords[0];
      if (evidence === undefined) throw new Error("需要 Evidence Record");
      await runtime.recordClaim({
        runId: waiting.runId,
        kind: "source_fact",
        text: "Run Journal 是 canonical history。",
        evidenceIds: [evidence.evidenceId],
      });
      const complete = await runtime.advanceResearch({ runId: waiting.runId });
      expect(complete.state.type).toBe("research_complete");
      await expect(runtime.proposeLearningArtifact({
        runId: waiting.runId,
        targetPath: join(outputRoot, "invalid.md"),
      })).rejects.toThrow();
      const projection = await runtime.inspectRun({ runId: waiting.runId });
      expect(projection.state).toMatchObject({
        type: "researching",
        evidenceGateRepairs: [expect.objectContaining({
          code: "proposal_invalid",
          artifactProposalTurnConsumed: true,
        })],
        retryAttempts: expect.arrayContaining([expect.objectContaining({
          retrySequenceKind: "artifact_proposal",
          outcome: "succeeded",
        })]),
      });
    } finally {
      runtime.close();
    }
  });

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
        retryAttempts: [
          expect.objectContaining({
            retrySequenceKind: "model_turn",
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
            retrySequenceKind: "model_turn",
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
          type: "retry_attempt_failed",
          retrySequenceKind: "model_turn",
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
      expect(formatRunTrace(trace, "human")).toContain(
        "retry-sequence-kind=model_turn attempt=1 outcome=retryable_failure duration-ms=5 retry-policy=retry-v1 failure=infrastructure_transient/rate_limited retry-delay-ms=250",
      );
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
        retrySequenceKind: "model_turn",
        attemptsUsed: 2,
        failure: {
          category: "infrastructure_transient",
          code: "service_unavailable",
        },
        retryAttempts: [
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
      expect(suspended.state.retryAttempts[1]).not.toHaveProperty(
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
    const generatedViews: ModelView[] = [];
    const model = completingModel((view) => {
      generatedViews.push(structuredClone(view));
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
        afterRetryAttemptStarted: () => {
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
      first.advanceResearch({
        runId: waiting.runId,
        steering: "只验证 durable steering",
      }),
    ).rejects.toMatchObject({ name: "ResearchLoopError" });
    const interrupted = await first.inspectRun({ runId: waiting.runId });
    expect(interrupted.state).toMatchObject({
      type: "researching",
      latestSteering: "只验证 durable steering",
      retryAttempts: [expect.objectContaining({
        attemptNumber: 1,
        outcome: "in_progress",
        latestSteering: "只验证 durable steering",
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
      const completed = await restarted.advanceResearch({
        runId: waiting.runId,
        steering: "不能改写正在恢复的 generation",
      });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        retryAttempts: [
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
            latestSteering: "只验证 durable steering",
            retryPolicy: policy,
          }),
        ],
      });
      expect(waits).toEqual([15]);
      expect(generationCalls).toBe(1);
      expect(generatedViews).toEqual([
        expect.objectContaining({
          latestSteering: "只验证 durable steering",
        }),
      ]);
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
        retryAttempts: [
          expect.objectContaining({ retrySequenceKind: "model_turn", outcome: "succeeded" }),
          expect.objectContaining({
            retrySequenceKind: "search_sources",
            attemptNumber: 1,
            outcome: "retryable_failure",
            retryDelayMs: 30,
          }),
          expect.objectContaining({
            retrySequenceKind: "search_sources",
            attemptNumber: 2,
            outcome: "succeeded",
          }),
          expect.objectContaining({ retrySequenceKind: "model_turn", outcome: "succeeded" }),
        ],
      });
      if (completed.state.type !== "research_complete") {
        throw new Error("测试要求 research_complete 状态");
      }
      const searchAttempts = completed.state.retryAttempts.filter(
        (attempt) => attempt.retrySequenceKind === "search_sources",
      );
      expect(new Set(searchAttempts.map((attempt) => attempt.retrySequenceId)).size).toBe(1);
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
        retryAttempts: expect.arrayContaining([
          expect.objectContaining({
            retrySequenceKind: "search_sources",
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
        retrySequenceKind: "model_turn",
        failure: { category: "model_contract", code: "invalid_model_turn" },
        retryAttempts: [expect.objectContaining({
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
      retryAttempts: [expect.objectContaining({ outcome: "succeeded" })],
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

  it("does not replay a default Model Turn after its commit window is interrupted", async () => {
    const runtimeHome = await createTemporaryDirectory("default-model-commit-runtime-");
    const sourceRoot = await createTemporaryDirectory("default-model-commit-source-");
    const ids = sequentialIds();
    const clock = incrementingClock();
    let generationCalls = 0;
    let interrupt = true;
    const model = completingModel(() => {
      generationCalls += 1;
    });
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
      researchLoopHooks: {
        beforeModelTurnJournalAppend: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟默认 Model Turn commit 前中断");
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
    await expect(first.inspectRun({ runId: waiting.runId })).resolves.toMatchObject({
      state: {
        type: "researching",
        modelTurns: [],
        retryAttempts: [expect.objectContaining({
          retrySequenceKind: "model_turn",
          retryPolicy: expect.objectContaining({ version: "retry-disabled-v1" }),
          outcome: "in_progress",
        })],
      },
    });
    expect(generationCalls).toBe(1);
    first.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      ids,
      clock,
    });
    try {
      await expect(restarted.advanceResearch({ runId: waiting.runId })).resolves.toMatchObject({
        state: {
          type: "retry_exhausted",
          retrySequenceKind: "model_turn",
          failure: {
            category: "infrastructure_transient",
            code: "model_turn_interrupted",
          },
        },
      });
      expect(generationCalls).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("does not replay a default serial Search after its commit window is interrupted", async () => {
    const runtimeHome = await createTemporaryDirectory("default-search-commit-runtime-");
    const sourceRoot = await createTemporaryDirectory("default-search-commit-source-");
    const ids = sequentialIds();
    const clock = incrementingClock();
    let modelCalls = 0;
    let searchCalls = 0;
    let interrupt = true;
    const model: ModelPort = {
      ...completingModel(() => undefined),
      generateResearchTurn: async () => {
        modelCalls += 1;
        return {
          text: "搜索。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId: "search",
            name: "search_sources",
            input: { query: "canonical", maxResults: 1 },
          }],
        };
      },
    };
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      sourceSearch: {
        search: async () => {
          searchCalls += 1;
          return [];
        },
      },
      ids,
      clock,
      researchLoopHooks: {
        afterSearchResultArtifactWrite: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟默认 Search commit 前中断");
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
    await expect(first.inspectRun({ runId: waiting.runId })).resolves.toMatchObject({
      state: {
        type: "researching",
        retryAttempts: [
          expect.objectContaining({ retrySequenceKind: "model_turn", outcome: "succeeded" }),
          expect.objectContaining({
            retrySequenceKind: "search_sources",
            retryPolicy: expect.objectContaining({ version: "retry-disabled-v1" }),
            outcome: "in_progress",
          }),
        ],
      },
    });
    expect(modelCalls).toBe(1);
    expect(searchCalls).toBe(1);
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
      ids,
      clock,
    });
    try {
      await expect(restarted.advanceResearch({ runId: waiting.runId })).resolves.toMatchObject({
        state: {
          type: "retry_exhausted",
          retrySequenceKind: "search_sources",
          failure: {
            category: "infrastructure_transient",
            code: "search_interrupted",
          },
        },
      });
      expect(modelCalls).toBe(1);
      expect(searchCalls).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("does not replay a default batched Search after its commit window is interrupted", async () => {
    const runtimeHome = await createTemporaryDirectory("default-batch-search-runtime-");
    const sourceRoot = await createTemporaryDirectory("default-batch-search-source-");
    const ids = sequentialIds();
    const clock = incrementingClock();
    let modelCalls = 0;
    let searchCalls = 0;
    let interrupt = true;
    const model: ModelPort = {
      ...completingModel(() => undefined),
      generateResearchTurn: async () => {
        modelCalls += 1;
        return {
          text: "并发搜索。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [
            {
              intentId: "search-1",
              name: "search_sources",
              input: { query: "canonical", maxResults: 1 },
            },
            {
              intentId: "search-2",
              name: "search_sources",
              input: { query: "projection", maxResults: 1 },
            },
          ],
        };
      },
    };
    const first = ResearchAgentRuntime.open({
      runtimeHome,
      model,
      sourceSearch: {
        search: async () => {
          searchCalls += 1;
          return [];
        },
      },
      ids,
      clock,
      safeReadConcurrency: 1,
      researchLoopHooks: {
        afterSearchResultArtifactWrite: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟默认 batched Search commit 前中断");
        },
      },
    });
    const waiting = await createWaitingRun(first, sourceRoot);
    await first.approvePlan({
      runId: waiting.runId,
      bindingHash: waiting.bindingHash,
    });
    await expect(first.advanceResearch({ runId: waiting.runId }))
      .rejects.toThrow();
    await expect(first.inspectRun({ runId: waiting.runId })).resolves.toMatchObject({
      state: {
        type: "researching",
        retryAttempts: [
          expect.objectContaining({ retrySequenceKind: "model_turn", outcome: "succeeded" }),
          expect.objectContaining({
            retrySequenceKind: "search_sources",
            intentId: "search-1",
            retryPolicy: expect.objectContaining({ version: "retry-disabled-v1" }),
            outcome: "in_progress",
          }),
        ],
      },
    });
    expect(modelCalls).toBe(1);
    expect(searchCalls).toBe(1);
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
      ids,
      clock,
      safeReadConcurrency: 1,
    });
    try {
      await expect(restarted.advanceResearch({ runId: waiting.runId })).resolves.toMatchObject({
        state: {
          type: "retry_exhausted",
          retrySequenceKind: "search_sources",
          failure: {
            category: "infrastructure_transient",
            code: "search_interrupted",
          },
        },
      });
      expect(modelCalls).toBe(1);
      expect(searchCalls).toBe(1);
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
        retryAttempts: [expect.objectContaining({ outcome: "in_progress" })],
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
    if (failedAttempt?.type !== "retry_attempt_failed") {
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
    if (retryableFailure?.type !== "retry_attempt_failed") {
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
    if (tamperedFailure?.type !== "retry_attempt_failed") {
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

  it("rejects reuse of a succeeded Model or Search Retry Sequence identity", () => {
    expect(() => reduceRunEvents(modelRetrySequenceIdReuseEvents())).toThrow(
      IllegalRunEventError,
    );
    expect(() => reduceRunEvents(searchRetrySequenceIdReuseEvents())).toThrow(
      IllegalRunEventError,
    );
  });

  it("keeps every Search retry on the frozen logical Tool Call lineage", () => {
    const validRetry = retryableSearchAttemptEvents();
    expect(() => reduceRunEvents(validRetry)).not.toThrow();

    for (const replacement of [
      { toolCallId: "tool-call-replaced" },
      { intentId: "intent-replaced" },
      { retrySequenceKind: "model_turn" as const, toolCallId: undefined, intentId: undefined },
      {
        retryPolicy: {
          version: "retry-replaced",
          modelMaxAttempts: 2,
          toolMaxAttempts: 2,
          baseDelayMs: 10,
          maxDelayMs: 100,
        },
      },
    ]) {
      const tampered = structuredClone(validRetry);
      const retryStart = tampered.at(-1);
      if (retryStart?.type !== "retry_attempt_started") {
        throw new Error("测试夹具缺少 retry started attempt");
      }
      tampered[tampered.length - 1] = {
        ...retryStart,
        payload: {
          attempt: {
            ...retryStart.payload.attempt,
            ...replacement,
          },
        },
      };
      expect(() => reduceRunEvents(tampered)).toThrow(
        IllegalRunEventError,
      );
    }
  });

  it("keeps Model retry steering frozen for one logical generation", () => {
    const events = retryReducerEvents(2).slice(0, 6);
    const started = events[4];
    const failed = events[5];
    if (
      started?.type !== "retry_attempt_started" ||
      failed?.type !== "retry_attempt_failed"
    ) {
      throw new Error("测试夹具缺少 Model retry facts");
    }
    events[4] = {
      ...started,
      payload: {
        attempt: {
          ...started.payload.attempt,
          latestSteering: "冻结 steering",
        },
      },
    };
    events[5] = {
      ...failed,
      payload: {
        attempt: {
          ...failed.payload.attempt,
          latestSteering: "冻结 steering",
          outcome: "retryable_failure",
          retryDelayMs: 10,
        },
      },
    };
    events.push({
      eventId: "event-model-retry-steering",
      runId: started.runId,
      sequence: 7,
      type: "retry_attempt_started",
      occurredAt: "2026-08-12T08:00:01.006Z",
      payload: {
        attempt: {
          ...started.payload.attempt,
          attemptId: "attempt-model-retry-steering",
          attemptNumber: 2,
          startedAt: "2026-08-12T08:00:01.006Z",
          latestSteering: "被篡改的 steering",
        },
      },
    });
    expect(() => reduceRunEvents(events)).toThrow(IllegalRunEventError);
  });

  it("rejects retry-enabled success facts that leave a pending attempt open", () => {
    const modelEvents = modelRetrySequenceIdReuseEvents().slice(0, 6);
    const modelCompleted = modelEvents.at(-1);
    if (modelCompleted?.type !== "model_turn_completed") {
      throw new Error("测试夹具缺少 Model completion");
    }
    modelEvents[modelEvents.length - 1] = {
      ...modelCompleted,
      payload: {
        turn: modelCompleted.payload.turn,
        generationStartedAt: modelCompleted.payload.generationStartedAt,
      },
    };
    expect(() => reduceRunEvents(modelEvents)).toThrow(IllegalRunEventError);

    const searchEvents = retryableSearchAttemptEvents();
    const searchStarted = searchEvents.at(-1);
    if (searchStarted?.type !== "retry_attempt_started") {
      throw new Error("测试夹具缺少 Search retry attempt");
    }
    const observedAt = "2026-08-12T08:00:04.000Z";
    const hash = "c".repeat(64);
    searchEvents.push({
      eventId: "event-search-without-attempt",
      runId: searchStarted.runId,
      sequence: searchStarted.sequence + 1,
      type: "research_tool_observed",
      occurredAt: observedAt,
      payload: {
        observation: {
          observationId: "observation-without-attempt",
          toolCallId: searchStarted.payload.attempt.toolCallId ?? "",
          intentId: searchStarted.payload.attempt.intentId ?? "",
          toolName: "search_sources",
          status: "succeeded",
          summary: "search_sources succeeded",
          output: {
            searchResultArtifact: {
              artifactId: `sha256:${hash}`,
              sha256: hash,
              mediaType: "application/json",
              byteLength: 2,
              relativePath: `artifacts/sha256/cc/${hash}.json`,
            },
            matchCount: 0,
          },
          observedAt,
        },
      },
    });
    expect(() => reduceRunEvents(searchEvents)).toThrow(IllegalRunEventError);
  });

  it("binds atomic Search success to the pending attempt Tool Call", () => {
    const events = searchRetrySequenceIdReuseEvents().slice(0, 8);
    expect(() => reduceRunEvents(events)).not.toThrow();
    const succeeded = events.at(-1);
    if (succeeded?.type !== "research_tool_observed") {
      throw new Error("测试夹具缺少 Search success");
    }
    events[events.length - 1] = {
      ...succeeded,
      payload: {
        ...succeeded.payload,
        observation: {
          ...succeeded.payload.observation,
          toolCallId: "tool-call-detached",
        },
      },
    };
    expect(() => reduceRunEvents(events)).toThrow(IllegalRunEventError);
  });

  it("binds an ordinary Search failure observation to its failed attempt", () => {
    const events = retryableSearchAttemptEvents().slice(0, 8);
    const failed = events.at(-1);
    if (failed?.type !== "retry_attempt_failed") {
      throw new Error("测试夹具缺少 Search failed attempt");
    }
    events[events.length - 1] = {
      ...failed,
      payload: {
        attempt: {
          ...failed.payload.attempt,
          outcome: "permanent_failure",
          retryDelayMs: undefined,
          failure: {
            category: "tool_execution",
            code: "search_failed",
          },
        },
      },
    };
    const observedAt = failed.occurredAt;
    events.push({
      eventId: "event-detached-search-failure",
      runId: failed.runId,
      sequence: failed.sequence + 1,
      type: "research_tool_observed",
      occurredAt: observedAt,
      payload: {
        observation: {
          observationId: "observation-detached-search-failure",
          toolCallId: "tool-call-detached",
          intentId: failed.payload.attempt.intentId ?? "",
          toolName: "search_sources",
          status: "failed",
          code: "search_failed",
          failure: {
            category: "tool_execution",
            code: "search_failed",
          },
          summary: "search_sources failed: search_failed",
          observedAt,
        },
      },
    });
    expect(() => reduceRunEvents(events)).toThrow(IllegalRunEventError);

    const mismatchedFailure = structuredClone(events);
    const observationEvent = mismatchedFailure.at(-1);
    if (observationEvent?.type !== "research_tool_observed") {
      throw new Error("测试夹具缺少 Search failure observation");
    }
    mismatchedFailure[mismatchedFailure.length - 1] = {
      ...observationEvent,
      payload: {
        observation: {
          ...observationEvent.payload.observation,
          toolCallId: failed.payload.attempt.toolCallId ?? "",
          failure: {
            category: "tool_execution",
            code: "different_failure",
          },
          code: "different_failure",
        },
      },
    };
    expect(() => reduceRunEvents(mismatchedFailure)).toThrow(
      IllegalRunEventError,
    );
  });

  it("rejects a new Retry Sequence while the latest attempt still requires recovery", () => {
    const inProgress = retryReducerEvents(2).slice(0, 5);
    const firstStart = inProgress.at(-1);
    if (firstStart?.type !== "retry_attempt_started") {
      throw new Error("测试夹具缺少 first started attempt");
    }
    inProgress.push({
      eventId: "event-new-sequence",
      runId: firstStart.runId,
      sequence: 6,
      type: "retry_attempt_started",
      occurredAt: "2026-08-12T08:00:01.001Z",
      payload: {
        attempt: {
          ...firstStart.payload.attempt,
          attemptId: "attempt-new-sequence",
          retrySequenceId: "retry-sequence-new",
          startedAt: "2026-08-12T08:00:01.001Z",
        },
      },
    });
    expect(() => reduceRunEvents(inProgress)).toThrow(IllegalRunEventError);

    const retryable = retryReducerEvents(2).slice(0, 6);
    const failed = retryable.at(-1);
    if (failed?.type !== "retry_attempt_failed") {
      throw new Error("测试夹具缺少 retryable failure");
    }
    retryable[retryable.length - 1] = {
      ...failed,
      payload: {
        attempt: {
          ...failed.payload.attempt,
          outcome: "retryable_failure",
          retryDelayMs: 10,
        },
      },
    };
    retryable.push({
      eventId: "event-replaced-sequence",
      runId: failed.runId,
      sequence: 7,
      type: "retry_attempt_started",
      occurredAt: "2026-08-12T08:00:01.006Z",
      payload: {
        attempt: {
          ...firstStart.payload.attempt,
          attemptId: "attempt-replaced-sequence",
          retrySequenceId: "retry-sequence-replaced",
          startedAt: "2026-08-12T08:00:01.006Z",
        },
      },
    });
    expect(() => reduceRunEvents(retryable)).toThrow(IllegalRunEventError);
  });

  it("rejects malformed attempt facts at the Journal schema boundary", () => {
    const started = structuredClone(retryReducerEvents()[4]);
    if (started?.type !== "retry_attempt_started") {
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
          retryAttempts: [
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
        retryAttempts: [expect.objectContaining({
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

  it("records an interrupted attempt before suspending an expired restarted Run", async () => {
    const runtimeHome = await createTemporaryDirectory("retry-expired-restart-runtime-");
    const sourceRoot = await createTemporaryDirectory("retry-expired-restart-source-");
    const baseTime = Date.UTC(2026, 7, 12, 8, 0, 0);
    let elapsedMs = 0;
    let interrupt = true;
    let generationCalls = 0;
    const runtime = ResearchAgentRuntime.open({
      runtimeHome,
      model: completingModel(() => {
        generationCalls += 1;
      }),
      clock: { now: () => new Date(baseTime + elapsedMs).toISOString() },
      ids: sequentialIds(),
      retryPolicy: {
        version: "retry-expired-v1",
        modelMaxAttempts: 2,
        toolMaxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
      retryScheduler: { wait: async () => undefined },
      researchLoopHooks: {
        afterRetryAttemptStarted: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("模拟 started fact 后进程中断");
        },
      },
    });
    try {
      const waiting = await runtime.createRun({
        question: "过期重启如何先分类 interrupted attempt？",
        sourceScope: {
          roots: [sourceRoot],
          exclusions: [],
          allowedExtensions: [".md"],
          maxFileBytes: 4_096,
          maxTotalBytes: 4_096,
        },
        runBudget: { ...generousBudget(), maxWallTimeMs: 5 },
      });
      if (waiting.state.type !== "waiting_plan_approval") {
        throw new Error("测试要求等待计划审批");
      }
      await runtime.approvePlan({
        runId: waiting.runId,
        bindingHash: waiting.state.approvalBinding.bindingHash,
      });
      await expect(runtime.advanceResearch({ runId: waiting.runId }))
        .rejects.toMatchObject({ name: "ResearchLoopError" });

      elapsedMs = 10;
      const suspended = await runtime.advanceResearch({ runId: waiting.runId });
      expect(suspended.state).toMatchObject({
        type: "budget_exhausted",
        exhaustedDimension: "wall_time",
        retryAttempts: [expect.objectContaining({
          outcome: "retryable_failure",
          failure: {
            category: "infrastructure_transient",
            code: "model_turn_interrupted",
          },
        })],
      });
      expect(generationCalls).toBe(0);
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
        retrySequenceKind: "search_sources",
        failure: {
          category: "invariant_violation",
          code: "invalid_search_result",
        },
      });
      const trace = await runtime.traceRun({ runId: waiting.runId });
      expect(trace.events.at(-1)).toMatchObject({
        type: "run_failed",
        retrySequenceKind: "search_sources",
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
        afterRetryAttemptStarted: () => {
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
      retryAttempts: [
        expect.objectContaining({ retrySequenceKind: "model_turn", outcome: "succeeded" }),
        expect.objectContaining({ retrySequenceKind: "search_sources", outcome: "in_progress" }),
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
      const attempts = completed.state.retryAttempts.filter(
        (attempt) => attempt.retrySequenceKind === "search_sources",
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
      type: "retry_attempt_started",
      occurredAt: startedAt,
      payload: {
        attempt: {
          attemptId: "attempt-001",
          retrySequenceId: "retry-sequence-001",
          retrySequenceKind: "model_turn",
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
      type: "retry_attempt_failed",
      occurredAt: completedAt,
      payload: {
        attempt: {
          attemptId: "attempt-001",
          retrySequenceId: "retry-sequence-001",
          retrySequenceKind: "model_turn",
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
        retrySequenceId: "retry-sequence-001",
        retrySequenceKind: "model_turn",
        attemptsUsed: 1,
        failure: {
          category: "infrastructure_transient",
          code: "request_timeout",
        },
      },
    },
  ];
}

function modelRetrySequenceIdReuseEvents(): ResearchRunEvent[] {
  const events = retryReducerEvents(2).slice(0, 5);
  const started = events[4];
  if (started?.type !== "retry_attempt_started") {
    throw new Error("测试夹具缺少 Model started attempt");
  }
  const completedAt = "2026-08-12T08:00:01.005Z";
  events.push({
    eventId: "event-006",
    runId: started.runId,
    sequence: 6,
    type: "model_turn_completed",
    occurredAt: completedAt,
    payload: {
      generationStartedAt: started.occurredAt,
      turn: {
        turnId: "turn-event-006",
        text: "先完成一个 Model Retry Sequence。",
        evidenceGaps: [],
        finishReason: "tool_calls",
        toolIntents: [{
          intentId: "search-001",
          name: "search_sources",
          input: { query: "journal", maxResults: 1 },
        }],
        completedAt,
      },
      attempt: {
        ...started.payload.attempt,
        outcome: "succeeded",
        completedAt,
        durationMs: 5,
      },
    },
  });
  events.push({
    eventId: "event-007",
    runId: started.runId,
    sequence: 7,
    type: "research_tool_observed",
    occurredAt: "2026-08-12T08:00:01.006Z",
    payload: {
      observation: {
        observationId: "observation-001",
        toolCallId: "tool-call-invalid",
        intentId: "search-001",
        toolName: "search_sources",
        status: "invalid",
        code: "invalid_tool_schema",
        failure: {
          category: "model_contract",
          code: "invalid_tool_schema",
        },
        summary: "invalid search schema",
        observedAt: "2026-08-12T08:00:01.006Z",
      },
    },
  });
  events.push({
    eventId: "event-008",
    runId: started.runId,
    sequence: 8,
    type: "retry_attempt_started",
    occurredAt: "2026-08-12T08:00:01.007Z",
    payload: {
      attempt: {
        ...started.payload.attempt,
        attemptId: "attempt-002",
        attemptNumber: 2,
        startedAt: "2026-08-12T08:00:01.007Z",
      },
    },
  });
  return events;
}

function searchRetrySequenceIdReuseEvents(): ResearchRunEvent[] {
  const events = retryReducerEvents(2).slice(0, 4);
  const runId = events[0]?.runId;
  const retryPolicy = events[0]?.type === "run_created"
    ? events[0].payload.retryPolicy
    : undefined;
  if (runId === undefined || retryPolicy === undefined) {
    throw new Error("测试夹具缺少 Run retry policy");
  }
  events.push(...modelSearchIntentEvents(runId, 5, "search-001", retryPolicy));
  events.push(searchAttemptStartedEvent({
    runId,
    sequence: 7,
    retryPolicy,
    attemptId: "search-attempt-001",
    retrySequenceId: "search-retry-sequence-001",
    attemptNumber: 1,
    toolCallId: "tool-call-001",
    intentId: "search-001",
  }));
  events.push(searchSucceededEvent({
    runId,
    sequence: 8,
    retryPolicy,
    attemptId: "search-attempt-001",
    retrySequenceId: "search-retry-sequence-001",
    attemptNumber: 1,
    toolCallId: "tool-call-001",
    intentId: "search-001",
  }));
  events.push(...modelSearchIntentEvents(runId, 9, "search-002", retryPolicy));
  events.push(searchAttemptStartedEvent({
    runId,
    sequence: 11,
    retryPolicy,
    attemptId: "search-attempt-002",
    retrySequenceId: "search-retry-sequence-001",
    attemptNumber: 2,
    toolCallId: "tool-call-002",
    intentId: "search-002",
  }));
  return events;
}

function retryableSearchAttemptEvents(): ResearchRunEvent[] {
  const events = retryReducerEvents(2).slice(0, 4);
  const runId = events[0]?.runId;
  const retryPolicy = events[0]?.type === "run_created"
    ? events[0].payload.retryPolicy
    : undefined;
  if (runId === undefined || retryPolicy === undefined) {
    throw new Error("测试夹具缺少 Run retry policy");
  }
  events.push(...modelSearchIntentEvents(runId, 5, "search-001", retryPolicy));
  const started = searchAttemptStartedEvent({
    runId,
    sequence: 7,
    retryPolicy,
    attemptId: "search-attempt-001",
    retrySequenceId: "search-retry-sequence-001",
    attemptNumber: 1,
    toolCallId: "tool-call-001",
    intentId: "search-001",
  });
  events.push(started);
  events.push({
    eventId: "event-search-failed-007",
    runId,
    sequence: 8,
    type: "retry_attempt_failed",
    occurredAt: "2026-08-12T08:00:03.005Z",
    payload: {
      attempt: {
        ...started.payload.attempt,
        outcome: "retryable_failure",
        completedAt: "2026-08-12T08:00:03.005Z",
        durationMs: 5,
        failure: {
          category: "infrastructure_transient",
          code: "connection_failed",
        },
        retryDelayMs: 10,
      },
    },
  });
  events.push(searchAttemptStartedEvent({
    runId,
    sequence: 9,
    retryPolicy,
    attemptId: "search-attempt-002",
    retrySequenceId: "search-retry-sequence-001",
    attemptNumber: 2,
    toolCallId: "tool-call-001",
    intentId: "search-001",
  }));
  return events;
}

function modelSearchIntentEvents(
  runId: string,
  sequence: number,
  intentId: string,
  retryPolicy: RetryPolicy,
): ResearchRunEvent[] {
  const startedAt = `2026-08-12T08:00:0${sequence - 4}.000Z`;
  const completedAt = `2026-08-12T08:00:0${sequence - 4}.005Z`;
  const attempt = {
    attemptId: `attempt-model-${sequence}`,
    retrySequenceId: `retry-sequence-model-${sequence}`,
    retrySequenceKind: "model_turn",
    attemptNumber: 1,
    retryPolicy,
    startedAt,
    outcome: "in_progress",
  } as const;
  const completedEventId = `event-model-${sequence + 1}`;
  return [
    {
      eventId: `event-model-started-${sequence}`,
      runId,
      sequence,
      type: "retry_attempt_started",
      occurredAt: startedAt,
      payload: { attempt },
    },
    {
      eventId: completedEventId,
      runId,
      sequence: sequence + 1,
      type: "model_turn_completed",
      occurredAt: completedAt,
      payload: {
        generationStartedAt: startedAt,
        turn: {
          turnId: `turn-${completedEventId}`,
          text: "请求搜索。",
          evidenceGaps: [],
          finishReason: "tool_calls",
          toolIntents: [{
            intentId,
            name: "search_sources",
            input: { query: "journal", maxResults: 1 },
          }],
          completedAt,
        },
        attempt: {
          ...attempt,
          outcome: "succeeded",
          completedAt,
          durationMs: 5,
        },
      },
    },
  ];
}

/** 构造 Search attempt 回放夹具所需的稳定 lineage 字段。 */
interface SearchAttemptFixtureInput {
  /** 夹具事件所属的 Research Run identity。 */
  readonly runId: string;
  /** 夹具事件在 Run Journal 中的连续序号。 */
  readonly sequence: number;
  /** Search Retry Sequence 首次 attempt 冻结的 Retry Policy。 */
  readonly retryPolicy: RetryPolicy;
  /** 当前物理 Search attempt identity。 */
  readonly attemptId: string;
  /** 所有 Search retries 共享的 Retry Sequence identity。 */
  readonly retrySequenceId: string;
  /** 当前物理 attempt 在 Retry Sequence 内的 1-based 序号。 */
  readonly attemptNumber: number;
  /** 所有 Search retries 必须共享的逻辑 Research Tool call identity。 */
  readonly toolCallId: string;
  /** Search attempts 必须保持绑定的 pending intent identity。 */
  readonly intentId: string;
}

function searchAttemptStartedEvent(input: SearchAttemptFixtureInput) {
  const startedAt = `2026-08-12T08:00:0${input.sequence - 4}.000Z`;
  return {
    eventId: `event-search-started-${input.sequence}`,
    runId: input.runId,
    sequence: input.sequence,
    type: "retry_attempt_started",
    occurredAt: startedAt,
    payload: {
      attempt: {
        attemptId: input.attemptId,
        retrySequenceId: input.retrySequenceId,
        retrySequenceKind: "search_sources",
        attemptNumber: input.attemptNumber,
        retryPolicy: input.retryPolicy,
        startedAt,
        outcome: "in_progress",
        toolCallId: input.toolCallId,
        intentId: input.intentId,
      },
    },
  } as const;
}

function searchSucceededEvent(input: SearchAttemptFixtureInput) {
  const observedAt = `2026-08-12T08:00:0${input.sequence - 4}.000Z`;
  const hash = "b".repeat(64);
  return {
    eventId: `event-search-succeeded-${input.sequence}`,
    runId: input.runId,
    sequence: input.sequence,
    type: "research_tool_observed",
    occurredAt: observedAt,
    payload: {
      observation: {
        observationId: "observation-search-001",
        toolCallId: input.toolCallId,
        intentId: input.intentId,
        toolName: "search_sources",
        status: "succeeded",
        summary: "search_sources succeeded",
        output: {
          searchResultArtifact: {
            artifactId: `sha256:${hash}`,
            sha256: hash,
            mediaType: "application/json",
            byteLength: 2,
            relativePath: `artifacts/sha256/bb/${hash}.json`,
          },
          matchCount: 0,
        },
        observedAt,
      },
      attempt: {
        attemptId: input.attemptId,
        retrySequenceId: input.retrySequenceId,
        retrySequenceKind: "search_sources",
        attemptNumber: input.attemptNumber,
        retryPolicy: input.retryPolicy,
        startedAt: `2026-08-12T08:00:0${input.sequence - 5}.000Z`,
        outcome: "succeeded",
        toolCallId: input.toolCallId,
        intentId: input.intentId,
        completedAt: observedAt,
        durationMs: 1_000,
      },
    },
  } as const;
}

function completingModel(onGenerate: (view: ModelView) => void): ModelPort {
  return {
    proposePlan: async () => ({
      title: "验证 interrupted attempt",
      objectives: ["重启后安全恢复"],
      steps: [{ id: "step-001", description: "完成 generation" }],
    }),
    proposeLearningArtifact: async () => {
      throw new Error("测试不会生成 Learning Artifact");
    },
    generateResearchTurn: async (view) => {
      onGenerate(view);
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

async function createClaimedRun(
  runtime: ResearchAgentRuntime,
  sourceRoot: string,
): Promise<string> {
  const waiting = await createWaitingRun(runtime, sourceRoot);
  await runtime.approvePlan({
    runId: waiting.runId,
    bindingHash: waiting.bindingHash,
  });
  const read = await runtime.readSource({
    runId: waiting.runId,
    request: {
      rootIndex: 0,
      relativePath: "journal.md",
      startLine: 1,
      endLine: 1,
    },
  });
  if (read.state.type !== "researching") throw new Error("需要 researching");
  const observation = read.state.sourceReadObservations[0];
  if (observation?.status !== "succeeded") throw new Error("需要 read success");
  const evidenced = await runtime.recordEvidence({
    runId: waiting.runId,
    observationId: observation.observationId,
  });
  if (evidenced.state.type !== "researching") throw new Error("需要 Evidence");
  const evidence = evidenced.state.evidenceRecords[0];
  if (evidence === undefined) throw new Error("需要 Evidence Record");
  await runtime.recordClaim({
    runId: waiting.runId,
    kind: "source_fact",
    text: "Run Journal 是 canonical history。",
    evidenceIds: [evidence.evidenceId],
  });
  return waiting.runId;
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
