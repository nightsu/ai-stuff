import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  createPlanApprovalBinding,
  createPublicationApprovalBinding,
  formatRunTrace,
  hashCanonicalJson,
  ResearchAgentRuntime,
  ScriptedEvaluator,
  ScriptedModel,
} from "../../src/index.js";
import { hashUtf8Text } from "../../src/domain/integrity.js";
import type {
  IdGenerator,
  Clock,
  RunBudget,
  SourceScope,
} from "../../src/index.js";
import {
  IllegalRunEventError,
  reduceRunEvents,
} from "../../src/domain/reducer.js";
import { parseRunProjection } from "../../src/domain/schemas.js";
import { SqliteRunStore } from "../../src/infrastructure/sqlite-run-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ResearchAgentRuntime Learning Artifact publication", () => {
  it("runs an isolated advisory Evaluator Review before exposing a publish-ready report", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "evaluated-report.md");

    try {
      const waiting = await fixture.runtime.proposeLearningArtifact({
        runId: fixture.runId,
        targetPath,
      });
      expect(waiting.state).toMatchObject({
        type: "waiting_publication_approval",
        evaluation: {
          kind: "reviewed",
          identity: {
            provider: "scripted",
            model: "scripted-evaluator",
            promptVersion: "evidence-evaluator-v1",
            inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            reviewArtifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          review: {
            verdicts: [{
              claimId: "claim-event-007",
              verdict: "supported",
            }],
          },
        },
        publicationBinding: {
          evaluationKind: "reviewed",
          evaluationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        publicationApprovalSummary: {
          hardGate: {
            status: "passed",
            claimCount: 1,
            evidenceCount: 1,
          },
          advisoryWarnings: [],
        },
      });
      if (waiting.state.type !== "waiting_publication_approval") {
        throw new Error("测试要求等待 publication approval");
      }
      const ready = await fixture.runtime.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      expect(ready.state).toMatchObject({
        type: "ready_to_publish",
        publicationReceipt: {
          evaluationKind: "reviewed",
          evaluationHash: waiting.state.publicationBinding.evaluationHash,
        },
      });
      await fixture.runtime.publishLearningArtifact({ runId: fixture.runId });

      const markdown = await readFile(targetPath, "utf8");
      expect(markdown).toContain("## Conclusion");
      expect(markdown).toContain("## Scope");
      expect(markdown).toContain("## Uncertainty");
      expect(markdown).toContain("Evaluator: supported");
      expect(markdown).toContain("source.md lines 2-3");
      expect(markdown).toContain("read_source tool-call-001");
      expect(markdown).toContain("- search_sources: 0");
      expect(markdown).toContain("- read_source: 1");
      expect(markdown).toContain("- record_evidence: 0");
      expect(markdown).toContain("- propose_claim: 0");
      expect(markdown).toContain("- complete_research: 0");
    } finally {
      fixture.runtime.close();
    }
  });

  it("suspends on Evaluator failure and retries the exact review without regenerating the proposal", async () => {
    const fixture = await createEvidenceReadyRun();
    fixture.runtime.close();
    const model = new ScriptedModel([], [{
      title: "Evaluator retry",
      summary: "失败后只重试 isolated review。",
      claimIds: ["claim-event-007"],
    }]);
    const evaluator = new ScriptedEvaluator([
      new Error("private provider body"),
      {
        verdicts: [{
          claimId: "claim-event-007",
          verdict: "uncertain",
        }],
      },
    ], {
      provider: "scripted",
      model: "flaky-evaluator",
      promptVersion: "evidence-evaluator-v1",
    });
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      ids: createIds(100),
      clock: fixedPublicationClock(),
      model,
      evaluator,
    });
    const targetPath = join(fixture.outputDirectory, "retry-review.md");

    try {
      await expect(
        runtime.proposeLearningArtifact({ runId: fixture.runId, targetPath }),
      ).rejects.toThrow(/Evaluator Review/);
      const suspended = await runtime.inspectRun({ runId: fixture.runId });
      expect(suspended.state).toMatchObject({
        type: "waiting_evaluator_resolution",
        proposal: { title: "Evaluator retry" },
        evaluatorFailures: [{ attempt: 1, code: "evaluation_failed" }],
      });

      const waiting = await runtime.retryEvaluatorReview({ runId: fixture.runId });
      expect(waiting.state).toMatchObject({
        type: "waiting_publication_approval",
        evaluation: {
          kind: "reviewed",
          review: {
            verdicts: [{
              claimId: "claim-event-007",
              verdict: "uncertain",
            }],
          },
        },
      });
      expect(model.learningArtifactRequests).toHaveLength(1);
      expect(evaluator.requests).toHaveLength(2);
      const trace = await runtime.traceRun({ runId: fixture.runId });
      expect(trace.events.slice(-2)).toEqual([
        expect.objectContaining({
          type: "evaluator_review_failed",
          evaluatorAttempt: 1,
          evaluatorFailureCode: "evaluation_failed",
          evaluatorInputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          evaluatorModel: "flaky-evaluator",
          evaluatorPromptVersion: "evidence-evaluator-v1",
        }),
        expect.objectContaining({
          type: "learning_artifact_draft_proposed",
          evaluationKind: "reviewed",
          evaluatorReviewArtifactId: expect.stringMatching(/^sha256:/),
          evaluationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
    } finally {
      runtime.close();
    }
  });

  it("rejects an Evaluator result outside the closed verdict contract", async () => {
    const fixture = await createEvidenceReadyRun();
    fixture.runtime.close();
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      ids: createIds(150),
      clock: fixedPublicationClock(),
      model: new ScriptedModel([], [{
        title: "Closed evaluator verdicts",
        summary: "非法 verdict 不能进入 publication state。",
        claimIds: ["claim-event-007"],
      }]),
      evaluator: new ScriptedEvaluator([{
        verdicts: [{
          claimId: "claim-event-007",
          verdict: "approved",
          explanation: "raw provider payload",
        }],
      } as never], {
        provider: "custom",
        model: "unsafe-evaluator",
        promptVersion: "evidence-evaluator-v1",
      }),
    });

    try {
      await expect(runtime.proposeLearningArtifact({
        runId: fixture.runId,
        targetPath: join(fixture.outputDirectory, "invalid-verdict.md"),
      })).rejects.toThrow(/Evaluator Review/);
      await expect(
        runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "waiting_evaluator_resolution",
          evaluatorFailures: [{ attempt: 1, code: "evaluation_failed" }],
        },
      });
      await expect(
        readFile(join(fixture.outputDirectory, "invalid-verdict.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      runtime.close();
    }
  });

  it("allows an explicit audited Evaluator skip without fabricating verdicts", async () => {
    const fixture = await createEvidenceReadyRun();
    fixture.runtime.close();
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      ids: createIds(200),
      clock: fixedPublicationClock(),
      model: new ScriptedModel([], [{
        title: "Explicit skip",
        summary: "用户可审计地跳过 advisory review。",
        claimIds: ["claim-event-007"],
      }]),
      evaluator: new ScriptedEvaluator(
        [new Error("evaluation unavailable")],
        {
          provider: "scripted",
          model: "failed-evaluator",
          promptVersion: "evidence-evaluator-v1",
        },
      ),
    });
    const targetPath = join(fixture.outputDirectory, "skipped-review.md");

    try {
      await expect(
        runtime.proposeLearningArtifact({ runId: fixture.runId, targetPath }),
      ).rejects.toThrow(/Evaluator Review/);
      const waiting = await runtime.skipEvaluatorReview({ runId: fixture.runId });
      expect(waiting.state).toMatchObject({
        type: "waiting_publication_approval",
        evaluation: {
          kind: "skipped",
          identity: {
            skipId: expect.stringContaining("event-"),
            skippedBy: "user-command",
          },
        },
        publicationBinding: {
          evaluationKind: "skipped",
          evaluationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        publicationApprovalSummary: {
          hardGate: { status: "passed", claimCount: 1, evidenceCount: 1 },
          advisoryWarnings: [{
            kind: "evaluator_skipped",
            skipId: expect.stringContaining("event-"),
          }],
        },
      });
      if (waiting.state.type !== "waiting_publication_approval") {
        throw new Error("测试要求等待 publication approval");
      }
      if (waiting.state.evaluation.kind !== "skipped") {
        throw new Error("测试要求 explicit Evaluator skip");
      }
      await runtime.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      await runtime.publishLearningArtifact({ runId: fixture.runId });
      const markdown = await readFile(targetPath, "utf8");
      expect(markdown).toContain("Evaluator: skipped");
      expect(markdown).not.toMatch(
        /Evaluator: (supported|partially_supported|unsupported|contradicted|uncertain)/,
      );
      const trace = await runtime.traceRun({ runId: fixture.runId });
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "learning_artifact_draft_proposed",
          evaluationKind: "skipped",
          evaluatorSkipId: waiting.state.evaluation.identity.skipId,
          evaluationHash: waiting.state.publicationBinding.evaluationHash,
        }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it("keeps Evaluator resolution suspended until retry, skip, or terminal cancellation", async () => {
    const fixture = await createEvidenceReadyRun();
    fixture.runtime.close();
    const evaluator = new ScriptedEvaluator(
      [new Error("unavailable")],
      {
        provider: "scripted",
        model: "unavailable-evaluator",
        promptVersion: "evidence-evaluator-v1",
      },
    );
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      ids: createIds(300),
      clock: fixedPublicationClock(),
      model: new ScriptedModel([], [{
        title: "Evaluator control",
        summary: "Evaluator wait 是独立 suspended state。",
        claimIds: ["claim-event-007"],
      }]),
      evaluator,
    });

    try {
      await expect(runtime.proposeLearningArtifact({
        runId: fixture.runId,
        targetPath: join(fixture.outputDirectory, "cancelled-review.md"),
      })).rejects.toThrow(/Evaluator Review/);
      await expect(runtime.pauseRun({ runId: fixture.runId })).rejects.toThrow();
      await expect(runtime.resumeRun({ runId: fixture.runId })).rejects.toThrow();
      const cancelled = await runtime.cancelRun({ runId: fixture.runId });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: { type: "waiting_evaluator_resolution" },
      });
      await expect(
        runtime.retryEvaluatorReview({ runId: fixture.runId }),
      ).rejects.toThrow();
      await expect(
        runtime.skipEvaluatorReview({ runId: fixture.runId }),
      ).rejects.toThrow();
      expect(evaluator.requests).toHaveLength(1);
    } finally {
      runtime.close();
    }

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      ids: createIds(350),
      clock: fixedPublicationClock(),
      model: new ScriptedModel([]),
    });
    try {
      await expect(
        restarted.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "cancelled",
          cancelledState: { type: "waiting_evaluator_resolution" },
        },
      });
      await expect(
        restarted.retryEvaluatorReview({ runId: fixture.runId }),
      ).rejects.toThrow();
      await expect(
        restarted.skipEvaluatorReview({ runId: fixture.runId }),
      ).rejects.toThrow();
    } finally {
      restarted.close();
    }
  });

  it("renders source facts, inferences, and design recommendations without treating interpretation as upstream fact", async () => {
    const fixture = await createEvidenceReadyRun({
      proposalClaimIds: [
        "claim-event-007",
        "claim-event-008",
        "claim-event-009",
      ],
    });
    const current = await fixture.runtime.inspectRun({ runId: fixture.runId });
    if (current.state.type !== "researching") {
      throw new Error("测试夹具要求仍处于 researching");
    }
    const evidence = current.state.evidenceRecords[0];
    if (evidence === undefined) {
      throw new Error("测试夹具要求一个可复用 Evidence Record");
    }

    await fixture.runtime.recordClaim({
      runId: fixture.runId,
      kind: "inference",
      text: "因此 Projection 可以作为可替换的派生视图。",
      evidenceIds: [evidence.evidenceId],
    });
    await fixture.runtime.recordClaim({
      runId: fixture.runId,
      kind: "design_recommendation",
      text: "建议只通过 Journal 事实恢复 Projection。",
      evidenceIds: [],
    });
    const targetPath = join(fixture.outputDirectory, "claim-kinds.md");

    try {
      const waiting = await fixture.runtime.proposeLearningArtifact({
        runId: fixture.runId,
        targetPath,
      });
      if (waiting.state.type !== "waiting_publication_approval") {
        throw new Error("测试要求等待 publication approval");
      }
      await fixture.runtime.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      await fixture.runtime.publishLearningArtifact({ runId: fixture.runId });

      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "claim-event-007 [source_fact]",
      );
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "claim-event-008 [inference]",
      );
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "claim-event-009 [design_recommendation]",
      );
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        `claim-event-008 [inference] (Evaluator: supported): 因此 Projection 可以作为可替换的派生视图。 【Evidence: ${evidence.evidenceId}】`,
      );
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "claim-event-009 [design_recommendation] (Evaluator: supported): 建议只通过 Journal 事实恢复 Projection。",
      );
      await expect(readFile(targetPath, "utf8")).resolves.not.toContain(
        "claim-event-009 [design_recommendation]: 建议只通过 Journal 事实恢复 Projection。 【Evidence:",
      );
    } finally {
      fixture.runtime.close();
    }
  });

  it("reuses one Evidence across Claims while preserving one artifact-to-Trace lineage chain", async () => {
    const fixture = await createEvidenceReadyRun({
      proposalClaimIds: ["claim-event-007", "claim-event-008"],
    });
    const current = await fixture.runtime.inspectRun({ runId: fixture.runId });
    if (current.state.type !== "researching") {
      throw new Error("测试夹具要求仍处于 researching");
    }
    const evidence = current.state.evidenceRecords[0];
    if (evidence === undefined) {
      throw new Error("测试夹具要求一个可复用 Evidence Record");
    }
    await fixture.runtime.recordClaim({
      runId: fixture.runId,
      kind: "inference",
      text: "Projection 因此可以从 Journal 确定性重建。",
      evidenceIds: [evidence.evidenceId],
    });
    const targetPath = join(fixture.outputDirectory, "shared-evidence.md");

    try {
      const waiting = await fixture.runtime.proposeLearningArtifact({
        runId: fixture.runId,
        targetPath,
      });
      if (waiting.state.type !== "waiting_publication_approval") {
        throw new Error("测试要求等待 publication approval");
      }
      await fixture.runtime.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      await fixture.runtime.publishLearningArtifact({ runId: fixture.runId });

      const markdown = await readFile(targetPath, "utf8");
      expect(markdown.match(new RegExp(`^\\- ${evidence.evidenceId}:`, "gm")))
        .toHaveLength(1);
      expect(markdown).toContain(
        `source.md lines ${evidence.startLine}-${evidence.endLine}; ${evidence.sourceSnapshotId}; read_source ${evidence.toolCallId}`,
      );
      expect(markdown.match(new RegExp(`【Evidence: ${evidence.evidenceId}】`, "g")))
        .toHaveLength(2);

      const trace = await fixture.runtime.traceRun({ runId: fixture.runId });
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "claim_recorded",
          claimId: "claim-event-007",
          claimKind: "source_fact",
          evidenceIds: [evidence.evidenceId],
        }),
        expect.objectContaining({
          type: "claim_recorded",
          claimId: "claim-event-008",
          claimKind: "inference",
          evidenceIds: [evidence.evidenceId],
        }),
        expect.objectContaining({
          type: "evidence_recorded",
          evidenceId: evidence.evidenceId,
          sourceSnapshotId: evidence.sourceSnapshotId,
          toolCallId: evidence.toolCallId,
        }),
      ]));
      expect(formatRunTrace(trace, "human")).toContain(
        `claim=claim-event-008 claim-kind=inference evidence-ids=${evidence.evidenceId}`,
      );
    } finally {
      fixture.runtime.close();
    }
  });

  it("validates Evidence against immutable Source Snapshot bytes instead of the changed live source", async () => {
    const fixture = await createEvidenceReadyRun();
    await writeFile(
      join(fixture.sourceRoot, "source.md"),
      "live source 后来已经变化。\n",
      "utf8",
    );

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "snapshot-backed.md"),
        }),
      ).resolves.toMatchObject({
        state: { type: "waiting_publication_approval" },
      });
    } finally {
      fixture.runtime.close();
    }
  });

  it("invalidates legacy explicit Plan Approval when the approved Source Root identity changes", async () => {
    const fixture = await createEvidenceReadyRun();
    const approvedRoot = `${fixture.sourceRoot}-approved`;
    await rename(fixture.sourceRoot, approvedRoot);
    await mkdir(fixture.sourceRoot);
    await writeFile(
      join(fixture.sourceRoot, "source.md"),
      "替代目录不能继承原计划审批。\n",
      "utf8",
    );

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "legacy-approval-invalid.md"),
        }),
      ).rejects.toThrow(/Evidence/);
      await expect(
        fixture.runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        lastEventSequence: 7,
        state: { type: "researching", evidenceGateRepairs: [] },
      });
    } finally {
      fixture.runtime.close();
      await rm(approvedRoot, { force: true, recursive: true });
    }
  });

  it("blocks a draft when the private Source Snapshot bytes no longer match their content identity", async () => {
    const fixture = await createEvidenceReadyRun();
    const current = await fixture.runtime.inspectRun({ runId: fixture.runId });
    if (current.state.type !== "researching") {
      throw new Error("测试夹具要求仍处于 researching");
    }
    const observation = current.state.sourceReadObservations[0];
    if (observation?.status !== "succeeded") {
      throw new Error("测试夹具要求一个成功来源 observation");
    }
    await writeFile(
      join(fixture.runtimeHome, observation.sourceSnapshot.relativePath),
      "title\nRun Journal 是 forged history。\nProjection 可从 Journal 重建。\n",
      "utf8",
    );

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "corrupt-snapshot.md"),
        }),
      ).rejects.toThrow(/Evidence/);
      await expect(
        fixture.runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "researching" } });
    } finally {
      fixture.runtime.close();
    }
  });

  it("revalidates immutable Source Snapshot lineage immediately before publication", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "tampered-after-approval.md");
    const current = await fixture.runtime.inspectRun({ runId: fixture.runId });
    if (current.state.type !== "researching") {
      throw new Error("测试夹具要求 draft 前处于 researching");
    }
    const observation = current.state.sourceReadObservations[0];
    if (observation?.status !== "succeeded") {
      throw new Error("测试夹具要求一个成功 Source Snapshot observation");
    }
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    await writeFile(
      join(fixture.runtimeHome, observation.sourceSnapshot.relativePath),
      "已被篡改的 Snapshot bytes。\n",
      "utf8",
    );

    try {
      await expect(
        fixture.runtime.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Learning Artifact/);
      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
      await expect(
        fixture.runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "ready_to_publish" } });
    } finally {
      fixture.runtime.close();
    }
  });

  it("revalidates the private Evaluator Review artifact immediately before publication", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "tampered-review.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (
      waiting.state.type !== "waiting_publication_approval" ||
      waiting.state.evaluation.kind !== "reviewed"
    ) {
      throw new Error("测试夹具要求存在成功 Evaluator Review");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    await writeFile(
      join(
        fixture.runtimeHome,
        waiting.state.evaluation.reviewArtifact.relativePath,
      ),
      '{"verdicts":[]}\n',
      "utf8",
    );

    try {
      await expect(
        fixture.runtime.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Learning Artifact/);
      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
      await expect(
        fixture.runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "ready_to_publish" } });
    } finally {
      fixture.runtime.close();
    }
  });

  it("blocks a self-consistent forged range whose excerpt does not match the immutable Snapshot", async () => {
    const fixture = await createEvidenceReadyRun();
    fixture.runtime.close();
    tamperEvidenceRange(fixture.runtimeHome, fixture.runId);
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel(
        [],
        [{
          title: "Journal 的可恢复性",
          summary: "必须从 immutable Snapshot 验证精确范围。",
          claimIds: ["claim-event-007"],
        }],
      ),
    });

    try {
      await expect(
        runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "forged-range.md"),
        }),
      ).rejects.toThrow(/Evidence/);
      await expect(runtime.inspectRun({ runId: fixture.runId })).resolves
        .toMatchObject({ state: { type: "researching" } });
    } finally {
      runtime.close();
    }
  });

  it("uses a ScriptedModel proposal to move approved plan through evidence gate, exact publication approval, and readable completed Markdown", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "journal-learning.md");

    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    expect(waiting.state).toMatchObject({
      type: "waiting_publication_approval",
      researchOrigin: "legacy_explicit",
      draftArtifact: {
        mediaType: "text/markdown; charset=utf-8",
      },
      publicationBinding: {
        draftHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetCanonicalPath: expect.any(String),
      },
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试要求等待 publication approval");
    }
    const fabricatedCompletion = structuredClone(waiting) as unknown as Record<
      string,
      unknown
    >;
    const fabricatedCompletionState = fabricatedCompletion.state;
    if (
      typeof fabricatedCompletionState !== "object" ||
      fabricatedCompletionState === null
    ) {
      throw new Error("测试要求 publication state object");
    }
    (fabricatedCompletionState as Record<string, unknown>).completion = {
      unresolvedQuestions: [],
      completedAt: "2026-08-12T08:00:00.000Z",
    };
    expect(() => parseRunProjection(fabricatedCompletion)).toThrow();
    const targetCanonicalPath = waiting.state.publicationTarget.targetCanonicalPath;
    fixture.runtime.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
    });
    try {
      const ready = await restarted.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      expect(ready.state.type).toBe("ready_to_publish");

      const completed = await restarted.publishLearningArtifact({
        runId: fixture.runId,
      });
      expect(completed.state).toMatchObject({
        type: "completed",
        learningArtifact: {
          targetCanonicalPath,
          sha256: waiting.state.draftArtifact.sha256,
        },
      });
      await expect(readFile(targetCanonicalPath, "utf8")).resolves.toContain(
        "# Journal 的可恢复性",
      );
      await expect(readFile(targetCanonicalPath, "utf8")).resolves.toContain(
        "【Evidence: evidence-event-006】",
      );
      await expect(readFile(targetCanonicalPath, "utf8")).resolves.toContain(
        "## Evidence Index",
      );
      await expect(readFile(targetCanonicalPath, "utf8")).resolves.toContain(
        "## Tool usage",
      );
      await expect(readFile(targetCanonicalPath, "utf8")).resolves.toContain(
        "tool-call-001",
      );
      const trace = await restarted.traceRun({ runId: fixture.runId });
      expect(trace.events.slice(-7)).toEqual([
        expect.objectContaining({
          type: "evidence_recorded",
          evidenceId: "evidence-event-006",
        }),
        expect.objectContaining({
          type: "claim_recorded",
          claimId: "claim-event-007",
        }),
        expect.objectContaining({
          type: "learning_artifact_draft_proposed",
          draftArtifactId: waiting.state.draftArtifact.artifactId,
        }),
        expect.objectContaining({
          type: "publication_approved",
          publicationApprovalId: expect.stringMatching(/^approval-/),
        }),
        expect.objectContaining({
          type: "publication_effect_prepared",
          publicationEffectStatus: "pending",
        }),
        expect.objectContaining({
          type: "publication_effect_execution_started",
          publicationEffectStatus: "executing",
        }),
        expect.objectContaining({
          type: "learning_artifact_published",
          learningArtifactSha256: waiting.state.draftArtifact.sha256,
        }),
      ]);
    } finally {
      restarted.close();
    }
  });

  it("keeps the exact Publication Approval durable after its post-commit fault point", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "approval-fault.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试要求等待 publication approval");
    }
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(75),
      clock: fixedPublicationClock(),
      approvalHooks: {
        afterPublicationApprovalCommit: () => {
          throw new Error("simulated approval process interruption");
        },
      },
    });
    await expect(interrupted.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    })).rejects.toThrow(/publication approval/);
    const committed = await interrupted.inspectRun({ runId: fixture.runId });
    expect(committed.state).toMatchObject({
      type: "ready_to_publish",
      publicationReceipt: {
        bindingHash: waiting.state.publicationBinding.bindingHash,
      },
    });
    interrupted.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(80),
      clock: fixedPublicationClock(),
    });
    try {
      await expect(restarted.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      })).resolves.toEqual(committed);
      const trace = await restarted.traceRun({ runId: fixture.runId });
      expect(trace.events.filter((event) =>
        event.type === "publication_approved"
      )).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("leaves Publication Approval unconsumed at its pre-commit fault point", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "approval-pre-commit.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试要求等待 publication approval");
    }
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(75),
      clock: fixedPublicationClock(),
      approvalHooks: {
        beforePublicationApprovalCommit: () => {
          throw new Error("simulated approval process interruption");
        },
      },
    });
    await expect(interrupted.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    })).rejects.toThrow(/publication approval/);
    await expect(interrupted.inspectRun({ runId: fixture.runId })).resolves
      .toEqual(waiting);
    const interruptedTrace = await interrupted.traceRun({ runId: fixture.runId });
    expect(interruptedTrace.events.some((event) =>
      event.type === "publication_approved"
    )).toBe(false);
    interrupted.close();

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(80),
      clock: fixedPublicationClock(),
    });
    try {
      await expect(restarted.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      })).resolves.toMatchObject({ state: { type: "ready_to_publish" } });
      const trace = await restarted.traceRun({ runId: fixture.runId });
      expect(trace.events.filter((event) =>
        event.type === "publication_approved"
      )).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("blocks draft creation when a source read has no valid Evidence Record and leaves no draft artifact", async () => {
    const fixture = await createEvidenceReadyRun({ recordEvidenceAndClaim: false });
    const targetPath = join(fixture.outputDirectory, "blocked.md");

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath,
        }),
      ).rejects.toThrow(/Evidence/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(5);
    } finally {
      fixture.runtime.close();
    }
  });

  it("rejects a model-selected forged Claim ID before it can create a draft artifact", async () => {
    const fixture = await createEvidenceReadyRun({
      proposalClaimIds: ["claim-forged-by-model"],
    });

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "forged.md"),
        }),
      ).rejects.toThrow(/Evidence/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(7);
    } finally {
      fixture.runtime.close();
    }
  });

  it("rejects a source read before it can exceed the approved tool-call budget", async () => {
    const fixture = await createEvidenceReadyRun({
      runBudget: { maxToolCalls: 1 },
    });

    try {
      await expect(
        fixture.runtime.readSource({
          runId: fixture.runId,
          request: {
            rootIndex: 0,
            relativePath: "source.md",
            startLine: 1,
            endLine: 1,
          },
        }),
      ).rejects.toThrow(/无法安全持久化/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(7);
    } finally {
      fixture.runtime.close();
    }
  });

  it("blocks the second ModelPort call when the approved model-turn budget only permits plan generation", async () => {
    const fixture = await createEvidenceReadyRun({
      runBudget: { maxModelTurns: 1 },
    });

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "model-budget.md"),
        }),
      ).rejects.toThrow(/Evidence/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
    } finally {
      fixture.runtime.close();
    }
  });

  it("rejects a source read before it can exceed the approved distinct-source budget", async () => {
    const fixture = await createEvidenceReadyRun({
      runBudget: { maxDistinctSources: 1 },
    });

    try {
      await expect(
        fixture.runtime.readSource({
          runId: fixture.runId,
          request: {
            rootIndex: 0,
            relativePath: "other.md",
            startLine: 1,
            endLine: 1,
          },
        }),
      ).rejects.toThrow(/无法安全持久化/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.lastEventSequence).toBe(7);
    } finally {
      fixture.runtime.close();
    }
  });

  it("counts distinct Source Snapshots instead of different paths with identical bytes", async () => {
    const fixture = await createEvidenceReadyRun({
      runBudget: { maxDistinctSources: 1 },
      otherSourceText:
        "title\nRun Journal 是 canonical history。\nProjection 可从 Journal 重建。\n",
    });
    await fixture.runtime.readSource({
      runId: fixture.runId,
      request: {
        rootIndex: 0,
        relativePath: "other.md",
        startLine: 1,
        endLine: 1,
      },
    });

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "same-snapshot.md"),
        }),
      ).resolves.toMatchObject({
        state: { type: "waiting_publication_approval" },
      });
    } finally {
      fixture.runtime.close();
    }
  });

  it("rejects direct draft replay after the approved wall-time budget expires", async () => {
    const fixture = await createEvidenceReadyRun();
    await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath: join(fixture.outputDirectory, "expired.md"),
    });
    fixture.runtime.close();

    const store = new SqliteRunStore(fixture.runtimeHome);
    const events = structuredClone(store.readEvents(fixture.runId));
    store.close();
    const draftEvent = events.at(-1);
    const createdEvent = events[0];
    const planEvent = events.find((event) => event.type === "plan_proposed");
    const approvedEvent = events.find((event) => event.type === "plan_approved");
    if (
      draftEvent?.type !== "learning_artifact_draft_proposed" ||
      createdEvent?.type !== "run_created" ||
      planEvent?.type !== "plan_proposed" ||
      approvedEvent?.type !== "plan_approved"
    ) {
      throw new Error("测试夹具要求完整的已批准 draft Journal");
    }
    const expiredBudget = {
      ...createdEvent.payload.runBudget,
      maxWallTimeMs: 1,
    };
    const expiredBinding = createPlanApprovalBinding({
      question: createdEvent.payload.question,
      planHash: planEvent.payload.planArtifact.sha256,
      sourceScope: createdEvent.payload.sourceScope,
      runBudget: expiredBudget,
    });
    events[0] = {
      ...createdEvent,
      payload: { ...createdEvent.payload, runBudget: expiredBudget },
    };
    const planIndex = events.indexOf(planEvent);
    events[planIndex] = {
      ...planEvent,
      payload: { ...planEvent.payload, approvalBinding: expiredBinding },
    };
    const approvalIndex = events.indexOf(approvedEvent);
    events[approvalIndex] = {
      ...approvedEvent,
      payload: {
        approvalReceipt: {
          ...approvedEvent.payload.approvalReceipt,
          ...expiredBinding,
        },
      },
    };
    events[events.length - 1] = {
      ...draftEvent,
      occurredAt: "2030-01-01T00:00:00.000Z",
    };

    expect(() => reduceRunEvents(events)).toThrow(IllegalRunEventError);
    expect(() => reduceRunEvents(events)).toThrow(/Evidence Gate/);
  });

  it("allows an already approved draft to publish after the research wall-time window closes", async () => {
    let now = "2026-08-12T00:00:00.000Z";
    const clock: Clock = { now: () => now };
    const fixture = await createEvidenceReadyRun({ clock });
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath: join(fixture.outputDirectory, "approved-after-window.md"),
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    now = "2030-01-01T00:00:00.000Z";

    try {
      const ready = await fixture.runtime.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      await expect(
        fixture.runtime.publishLearningArtifact({ runId: ready.runId }),
      ).resolves.toMatchObject({ state: { type: "completed" } });
    } finally {
      fixture.runtime.close();
    }
  });

  it("rejects a model proposal that tries to render its own Evidence citation token", async () => {
    const fixture = await createEvidenceReadyRun();
    fixture.runtime.close();
    const maliciousRuntime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: {
        proposePlan: async () => {
          throw new Error("测试不应再次请求计划");
        },
        proposeLearningArtifact: async () =>
          ({
            title: "Journal 的可恢复性",
            summary: "模型不能加入 【Evidence: evidence-forged】。",
            claimIds: ["claim-event-007"],
          }) as never,
      },
    });

    try {
      await expect(
        maliciousRuntime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputDirectory, "forged-citation.md"),
        }),
      ).rejects.toThrow(/Learning Artifact/);
      const projection = await maliciousRuntime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(7);
    } finally {
      maliciousRuntime.close();
    }
  });

  it("rejects a publication target outside the configured Output Root", async () => {
    const fixture = await createEvidenceReadyRun();
    const outsideDirectory = await createTemporaryDirectory("artifact-outside-");

    try {
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(outsideDirectory, "outside.md"),
        }),
      ).rejects.toThrow(/Learning Artifact/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("researching");
      expect(projection.lastEventSequence).toBe(7);
    } finally {
      fixture.runtime.close();
    }
  });

  it("projects each Evidence Record with the exact source observation and tool-call lineage", async () => {
    const fixture = await createEvidenceReadyRun();

    try {
      const reread = await fixture.runtime.readSource({
        runId: fixture.runId,
        request: {
          rootIndex: 0,
          relativePath: "source.md",
          startLine: 1,
          endLine: 1,
        },
      });
      if (reread.state.type !== "researching") {
        throw new Error("测试夹具要求第二次读取后仍处于 researching");
      }
      const secondObservation = reread.state.sourceReadObservations.at(-1);
      if (secondObservation?.status !== "succeeded") {
        throw new Error("测试夹具要求第二个成功 observation");
      }
      const evidenced = await fixture.runtime.recordEvidence({
        runId: fixture.runId,
        observationId: secondObservation.observationId,
      });
      if (evidenced.state.type !== "researching") {
        throw new Error("测试夹具要求第二个 Evidence 后仍处于 researching");
      }
      const secondEvidence = evidenced.state.evidenceRecords.at(-1);
      if (secondEvidence === undefined) {
        throw new Error("测试夹具要求第二个 Evidence Record");
      }

      const trace = await fixture.runtime.traceRun({ runId: fixture.runId });
      const evidenceTrace = trace.events.filter(
        (event) => event.type === "evidence_recorded",
      );
      expect(evidenceTrace).toEqual([
        expect.objectContaining({
          evidenceId: "evidence-event-006",
          observationId: "observation-001",
          toolCallId: "tool-call-001",
        }),
        expect.objectContaining({
          evidenceId: secondEvidence.evidenceId,
          observationId: secondObservation.observationId,
          toolCallId: secondObservation.toolCallId,
        }),
      ]);
    } finally {
      fixture.runtime.close();
    }
  });

  it("invalidates a publication approval when its approved parent directory identity changes", async () => {
    const fixture = await createEvidenceReadyRun();
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath: join(fixture.outputDirectory, "moved-target.md"),
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试要求等待 publication approval");
    }
    const canonicalParent = dirname(
      waiting.state.publicationTarget.targetCanonicalPath,
    );
    await rename(canonicalParent, `${canonicalParent}-before-replace`);
    await mkdir(canonicalParent);

    try {
      await expect(
        fixture.runtime.approvePublication({
          runId: fixture.runId,
          bindingHash: waiting.state.publicationBinding.bindingHash,
        }),
      ).rejects.toThrow(/过期/);
      const projection = await fixture.runtime.inspectRun({ runId: fixture.runId });
      expect(projection.state.type).toBe("waiting_publication_approval");
    } finally {
      fixture.runtime.close();
      await rm(`${canonicalParent}-before-replace`, {
        force: true,
        recursive: true,
      });
    }
  });

  it("refuses a persisted target when a restarted Runtime is configured with a different Output Root", async () => {
    const fixture = await createEvidenceReadyRun();
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath: join(fixture.outputDirectory, "different-root.md"),
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();
    const otherOutputRoot = await createTemporaryDirectory("artifact-other-output-");
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: otherOutputRoot,
      model: new ScriptedModel([]),
    });

    try {
      await expect(
        restarted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Learning Artifact/);
      const persisted = await restarted.inspectRun({ runId: fixture.runId });
      expect(persisted.state.type).toBe("ready_to_publish");
    } finally {
      restarted.close();
    }
  });

  it("recovers the same durable Publication Effect after preparation commits", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "prepared-effect.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();
    let interruptOnce = true;
    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(100),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterEffectPrepared: () => {
          if (!interruptOnce) return;
          interruptOnce = false;
          throw new Error("simulated process interruption");
        },
      },
    });

    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect|Learning Artifact/);
      const pending = await interrupted.inspectRun({ runId: fixture.runId });
      expect(pending.state).toMatchObject({
        type: "publication_pending",
        publicationEffect: {
          effectId: expect.stringMatching(/^publication-effect:[a-f0-9]{64}$/),
          runId: fixture.runId,
          draftHash: waiting.state.draftArtifact.sha256,
          targetCanonicalPath: waiting.state.publicationTarget.targetCanonicalPath,
          status: "pending",
        },
      });
      const trace = await interrupted.traceRun({ runId: fixture.runId });
      expect(trace.events.at(-1)).toMatchObject({
        type: "publication_effect_prepared",
        stateAfter: "publication_pending",
        publicationEffectId:
          (pending.state.type === "publication_pending"
            ? pending.state.publicationEffect.effectId
            : undefined),
        publicationEffectStatus: "pending",
      });
    } finally {
      interrupted.close();
    }
  });

  it("lets a durable cancellation win before a PENDING Publication Effect starts external execution", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "cancel-pending-effect.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    let publishingRuntime: ResearchAgentRuntime;
    publishingRuntime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(150),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterEffectPrepared: async () => {
          await publishingRuntime.cancelRun({ runId: fixture.runId });
        },
      },
    });
    try {
      const cancelled = await publishingRuntime.publishLearningArtifact({
        runId: fixture.runId,
      });
      expect(cancelled.state).toMatchObject({
        type: "cancelled",
        cancelledState: {
          type: "publication_pending",
          publicationEffect: { status: "pending" },
        },
      });
      const trace = await publishingRuntime.traceRun({ runId: fixture.runId });
      expect(trace.events.map((event) => event.type)).not.toContain(
        "publication_effect_execution_started",
      );
      await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      publishingRuntime.close();
    }
  });

  it("reconciles a crash after atomic publication as success without rewriting matching target bytes", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "reconciled-success.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(200),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterAtomicPublish: () => {
          throw new Error("simulated crash after final publication");
        },
      },
    });
    let effectId: string;
    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect|Learning Artifact/);
      const executing = await interrupted.inspectRun({ runId: fixture.runId });
      expect(executing.state).toMatchObject({
        type: "publication_executing",
        publicationEffect: {
          status: "executing",
          effectId: expect.stringMatching(/^publication-effect:[a-f0-9]{64}$/),
        },
      });
      if (executing.state.type !== "publication_executing") {
        throw new Error("测试要求 executing Publication Effect");
      }
      effectId = executing.state.publicationEffect.effectId;
      await expect(
        interrupted.cancelRun({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect/);
      await expect(
        interrupted.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "publication_executing",
          publicationEffect: { effectId },
        },
      });
    } finally {
      interrupted.close();
    }

    const beforeReconcile = await stat(targetPath, { bigint: true });
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(300),
      clock: fixedPublicationClock(),
    });
    try {
      const completed = await restarted.reconcilePublicationEffect({
        runId: fixture.runId,
      });
      expect(completed.state).toMatchObject({
        type: "completed",
        publicationEffect: {
          status: "succeeded",
          effectId,
          settlement: "reconciled",
        },
      });
      const afterReconcile = await stat(targetPath, { bigint: true });
      expect(afterReconcile.ino).toBe(beforeReconcile.ino);
      expect(afterReconcile.mtimeNs).toBe(beforeReconcile.mtimeNs);
      const trace = await restarted.traceRun({ runId: fixture.runId });
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "publication_effect_execution_started",
          publicationEffectId: effectId,
          publicationEffectStatus: "executing",
        }),
        expect.objectContaining({
          type: "publication_effect_unknown",
          publicationEffectId: effectId,
          publicationEffectStatus: "unknown",
        }),
        expect.objectContaining({
          type: "learning_artifact_published",
          publicationEffectId: effectId,
          publicationEffectStatus: "succeeded",
        }),
      ]));
      expect(formatRunTrace(trace, "human")).toContain(
        `publication-effect=${effectId} publication-effect-status=succeeded`,
      );
    } finally {
      restarted.close();
    }
  });

  it("retries a missing target with the same Publication Effect identity", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "reconciled-retry.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(400),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterAtomicPublish: async () => {
          await rm(targetPath);
          throw new Error("simulated lost target before settlement");
        },
      },
    });
    let effectId: string;
    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect|Learning Artifact/);
      const executing = await interrupted.inspectRun({ runId: fixture.runId });
      if (executing.state.type !== "publication_executing") {
        throw new Error("测试要求 executing Publication Effect");
      }
      effectId = executing.state.publicationEffect.effectId;
    } finally {
      interrupted.close();
    }

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(500),
      clock: fixedPublicationClock(),
    });
    try {
      const pending = await restarted.reconcilePublicationEffect({
        runId: fixture.runId,
      });
      expect(pending.state).toMatchObject({
        type: "publication_pending",
        publicationEffect: { status: "pending", effectId },
      });
      const completed = await restarted.publishLearningArtifact({
        runId: fixture.runId,
      });
      expect(completed.state).toMatchObject({
        type: "completed",
        publicationEffect: { status: "succeeded", effectId },
      });
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "# Journal 的可恢复性",
      );
    } finally {
      restarted.close();
    }
  });

  it("persists a no-clobber conflict when reconciliation finds different target bytes", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "reconciled-conflict.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(600),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterAtomicPublish: async () => {
          await writeFile(targetPath, "# Other writer\n", "utf8");
          throw new Error("simulated target replacement before settlement");
        },
      },
    });
    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect|Learning Artifact/);
    } finally {
      interrupted.close();
    }

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(700),
      clock: fixedPublicationClock(),
    });
    try {
      const conflicted = await restarted.reconcilePublicationEffect({
        runId: fixture.runId,
      });
      expect(conflicted.state).toMatchObject({
        type: "publication_conflict",
        publicationEffect: {
          status: "conflict",
          observedTargetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      await expect(
        restarted.cancelRun({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect/);
      await expect(readFile(targetPath, "utf8")).resolves.toBe(
        "# Other writer\n",
      );
      await expect(
        restarted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/当前 Research Run 状态/);
      const effectId = conflicted.state.type === "publication_conflict"
        ? conflicted.state.publicationEffect.effectId
        : undefined;
      await rm(targetPath);
      await mkdir(targetPath);
      const unknown = await restarted.reconcilePublicationEffect({
        runId: fixture.runId,
      });
      expect(unknown.state).toMatchObject({
        type: "publication_unknown",
        publicationEffect: {
          status: "unknown",
          effectId,
          reason: "reconciliation_inconclusive",
        },
      });
      await expect(
        restarted.cancelRun({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect/);
      await rm(targetPath, { recursive: true });
      const pending = await restarted.reconcilePublicationEffect({
        runId: fixture.runId,
      });
      expect(pending.state).toMatchObject({
        type: "publication_pending",
        publicationEffect: { status: "pending", effectId },
      });
    } finally {
      restarted.close();
    }
  });

  it("enters CONFLICT during direct execution when the approved target already has different bytes", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "direct-conflict.md");
    await writeFile(targetPath, "# Existing\n", "utf8");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    try {
      const conflicted = await fixture.runtime.publishLearningArtifact({
        runId: fixture.runId,
      });
      expect(conflicted.state).toMatchObject({
        type: "publication_conflict",
        publicationEffect: { status: "conflict" },
      });
      await expect(readFile(targetPath, "utf8")).resolves.toBe(
        "# Existing\n",
      );
    } finally {
      fixture.runtime.close();
    }
  });

  it("keeps UNKNOWN durable when reconciliation cannot safely classify the target", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "reconciled-unknown.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(800),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterAtomicPublish: () => {
          throw new Error("simulated crash after final publication");
        },
      },
    });
    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect|Learning Artifact/);
    } finally {
      interrupted.close();
    }

    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(900),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        beforeReconciliation: async () => {
          await rm(targetPath);
          await mkdir(targetPath);
        },
      },
    });
    try {
      const unknown = await restarted.reconcilePublicationEffect({
        runId: fixture.runId,
      });
      expect(unknown.state).toMatchObject({
        type: "publication_unknown",
        publicationEffect: {
          status: "unknown",
          reason: "reconciliation_inconclusive",
        },
      });
      const trace = await restarted.traceRun({ runId: fixture.runId });
      expect(trace.events.slice(-2)).toEqual([
        expect.objectContaining({
          type: "publication_effect_unknown",
          publicationEffectStatus: "unknown",
        }),
        expect.objectContaining({
          type: "publication_effect_unknown",
          publicationEffectStatus: "unknown",
        }),
      ]);
    } finally {
      restarted.close();
    }
  });

  it("fails reconciliation closed when the approved target identity changed", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "stale-reconcile.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(1000),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterAtomicPublish: () => {
          throw new Error("simulated crash after final publication");
        },
      },
    });
    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Publication Effect|Learning Artifact/);
    } finally {
      interrupted.close();
    }

    const movedOutput = `${fixture.outputDirectory}-before-replace`;
    await rename(fixture.outputDirectory, movedOutput);
    await mkdir(fixture.outputDirectory);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(1100),
      clock: fixedPublicationClock(),
    });
    try {
      await expect(
        restarted.reconcilePublicationEffect({ runId: fixture.runId }),
      ).rejects.toThrow(/Learning Artifact/);
      const unknown = await restarted.inspectRun({ runId: fixture.runId });
      expect(unknown.state).toMatchObject({
        type: "publication_unknown",
        publicationEffect: { status: "unknown" },
      });
    } finally {
      restarted.close();
      await rm(fixture.outputDirectory, { force: true, recursive: true });
      await rename(movedOutput, fixture.outputDirectory);
    }
  });

  it("revalidates Publication Approval before retrying a PENDING effect", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(fixture.outputDirectory, "stale-pending.md");
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(1200),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterEffectPrepared: () => {
          throw new Error("simulated crash after prepare");
        },
      },
    });
    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Learning Artifact/);
    } finally {
      interrupted.close();
    }

    const movedOutput = `${fixture.outputDirectory}-pending-before-replace`;
    await rename(fixture.outputDirectory, movedOutput);
    await mkdir(fixture.outputDirectory);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(1300),
      clock: fixedPublicationClock(),
    });
    try {
      await expect(
        restarted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Learning Artifact/);
      const pending = await restarted.inspectRun({ runId: fixture.runId });
      expect(pending.state.type).toBe("publication_pending");
    } finally {
      restarted.close();
      await rm(fixture.outputDirectory, { force: true, recursive: true });
      await rename(movedOutput, fixture.outputDirectory);
    }
  });

  it.each([
    ["beforeEffectPrepared", "ready_to_publish"],
    ["afterEffectPrepared", "publication_pending"],
    ["beforeTemporaryWrite", "publication_executing"],
    ["afterTemporaryWrite", "publication_executing"],
    ["beforeAtomicPublish", "publication_executing"],
    ["afterAtomicPublish", "publication_executing"],
    ["beforeSuccessSettlement", "publication_executing"],
  ] as const)(
    "recovers the durable state after the %s publication fault point",
    async (faultPoint, expectedState) => {
      const fixture = await createEvidenceReadyRun();
      const targetPath = join(
        fixture.outputDirectory,
        `fault-${faultPoint}.md`,
      );
      const waiting = await fixture.runtime.proposeLearningArtifact({
        runId: fixture.runId,
        targetPath,
      });
      if (waiting.state.type !== "waiting_publication_approval") {
        throw new Error("测试夹具要求等待 publication approval");
      }
      await fixture.runtime.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      fixture.runtime.close();

      const interrupted = ResearchAgentRuntime.open({
        runtimeHome: fixture.runtimeHome,
        outputRoot: fixture.outputDirectory,
        model: new ScriptedModel([]),
        ids: createIds(1400),
        clock: fixedPublicationClock(),
        publicationEffectHooks: {
          [faultPoint]: () => {
            throw new Error(`simulated ${faultPoint}`);
          },
        },
      });
      try {
        await expect(
          interrupted.publishLearningArtifact({ runId: fixture.runId }),
        ).rejects.toThrow(/Learning Artifact/);
        const projection = await interrupted.inspectRun({
          runId: fixture.runId,
        });
        expect(projection.state.type).toBe(expectedState);
      } finally {
        interrupted.close();
      }

      const restarted = ResearchAgentRuntime.open({
        runtimeHome: fixture.runtimeHome,
        outputRoot: fixture.outputDirectory,
        model: new ScriptedModel([]),
        ids: createIds(1500),
        clock: fixedPublicationClock(),
      });
      try {
        const current = await restarted.inspectRun({ runId: fixture.runId });
        if (current.state.type === "completed") return;
        if (current.state.type === "ready_to_publish") {
          await expect(
            restarted.publishLearningArtifact({ runId: fixture.runId }),
          ).resolves.toMatchObject({ state: { type: "completed" } });
          return;
        }
        if (current.state.type === "publication_pending") {
          // temporary-file fault points leave no final name; a direct safe retry
          // begins a fresh execution attempt under the same stable effect identity.
          await expect(
            restarted.publishLearningArtifact({ runId: fixture.runId }),
          ).resolves.toMatchObject({ state: { type: "completed" } });
          return;
        }
        const reconciled = await restarted.reconcilePublicationEffect({
          runId: fixture.runId,
        });
        if (reconciled.state.type === "publication_pending") {
          await expect(
            restarted.publishLearningArtifact({ runId: fixture.runId }),
          ).resolves.toMatchObject({ state: { type: "completed" } });
        } else {
          expect(reconciled.state.type).toBe("completed");
        }
      } finally {
        restarted.close();
      }
    },
  );

  it("keeps SUCCEEDED terminal after the afterSuccessSettlement fault point", async () => {
    const fixture = await createEvidenceReadyRun();
    const targetPath = join(
      fixture.outputDirectory,
      "fault-afterSuccessSettlement.md",
    );
    const waiting = await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath,
    });
    if (waiting.state.type !== "waiting_publication_approval") {
      throw new Error("测试夹具要求等待 publication approval");
    }
    await fixture.runtime.approvePublication({
      runId: fixture.runId,
      bindingHash: waiting.state.publicationBinding.bindingHash,
    });
    fixture.runtime.close();

    const interrupted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(1550),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        afterSuccessSettlement: () => {
          throw new Error("simulated afterSuccessSettlement");
        },
      },
    });
    try {
      await expect(
        interrupted.publishLearningArtifact({ runId: fixture.runId }),
      ).rejects.toThrow(/Learning Artifact/);
      await expect(
        interrupted.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "completed",
          publicationEffect: { status: "succeeded" },
        },
      });
    } finally {
      interrupted.close();
    }

    const beforeRestart = await stat(targetPath, { bigint: true });
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputDirectory,
      model: new ScriptedModel([]),
      ids: createIds(1575),
      clock: fixedPublicationClock(),
      publicationEffectHooks: {
        beforeTemporaryWrite: () => {
          throw new Error("completed effect must never execute again");
        },
      },
    });
    try {
      await expect(
        restarted.publishLearningArtifact({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "completed",
          publicationEffect: { status: "succeeded" },
        },
      });
      const afterRestart = await stat(targetPath, { bigint: true });
      expect(afterRestart.ino).toBe(beforeRestart.ino);
      expect(afterRestart.mtimeNs).toBe(beforeRestart.mtimeNs);
    } finally {
      restarted.close();
    }
  });

  it.each(["beforeReconciliation", "afterReconciliation"] as const)(
    "keeps UNKNOWN recoverable after the %s fault point",
    async (faultPoint) => {
      const fixture = await createEvidenceReadyRun();
      const targetPath = join(
        fixture.outputDirectory,
        `fault-${faultPoint}.md`,
      );
      const waiting = await fixture.runtime.proposeLearningArtifact({
        runId: fixture.runId,
        targetPath,
      });
      if (waiting.state.type !== "waiting_publication_approval") {
        throw new Error("测试夹具要求等待 publication approval");
      }
      await fixture.runtime.approvePublication({
        runId: fixture.runId,
        bindingHash: waiting.state.publicationBinding.bindingHash,
      });
      fixture.runtime.close();

      const interruptedPublish = ResearchAgentRuntime.open({
        runtimeHome: fixture.runtimeHome,
        outputRoot: fixture.outputDirectory,
        model: new ScriptedModel([]),
        ids: createIds(1600),
        clock: fixedPublicationClock(),
        publicationEffectHooks: {
          afterAtomicPublish: () => {
            throw new Error("simulated crash before settlement");
          },
        },
      });
      try {
        await expect(
          interruptedPublish.publishLearningArtifact({ runId: fixture.runId }),
        ).rejects.toThrow(/Learning Artifact/);
      } finally {
        interruptedPublish.close();
      }

      const interruptedReconcile = ResearchAgentRuntime.open({
        runtimeHome: fixture.runtimeHome,
        outputRoot: fixture.outputDirectory,
        model: new ScriptedModel([]),
        ids: createIds(1700),
        clock: fixedPublicationClock(),
        publicationEffectHooks: {
          [faultPoint]: () => {
            throw new Error(`simulated ${faultPoint}`);
          },
        },
      });
      try {
        await expect(
          interruptedReconcile.reconcilePublicationEffect({
            runId: fixture.runId,
          }),
        ).rejects.toThrow(/Learning Artifact/);
        const unknown = await interruptedReconcile.inspectRun({
          runId: fixture.runId,
        });
        expect(unknown.state).toMatchObject({
          type: "publication_unknown",
          publicationEffect: { status: "unknown" },
        });
      } finally {
        interruptedReconcile.close();
      }

      const restarted = ResearchAgentRuntime.open({
        runtimeHome: fixture.runtimeHome,
        outputRoot: fixture.outputDirectory,
        model: new ScriptedModel([]),
        ids: createIds(1800),
        clock: fixedPublicationClock(),
      });
      try {
        await expect(
          restarted.reconcilePublicationEffect({ runId: fixture.runId }),
        ).resolves.toMatchObject({ state: { type: "completed" } });
      } finally {
        restarted.close();
      }
    },
  );

  it("rejects a direct replay that recomputes a binding around a forged draft hash", async () => {
    const fixture = await createEvidenceReadyRun();
    await fixture.runtime.proposeLearningArtifact({
      runId: fixture.runId,
      targetPath: join(fixture.outputDirectory, "tampered.md"),
    });
    fixture.runtime.close();

    const store = new SqliteRunStore(fixture.runtimeHome);
    const events = structuredClone(store.readEvents(fixture.runId));
    store.close();
    const draftEvent = events.at(-1);
    if (draftEvent?.type !== "learning_artifact_draft_proposed") {
      throw new Error("测试夹具要求最后一个事件为 Learning Artifact draft");
    }
    const forgedSha256 = "f".repeat(64);
    const forgedArtifact = {
      ...draftEvent.payload.draftArtifact,
      artifactId: `sha256:${forgedSha256}`,
      sha256: forgedSha256,
    };
    events[events.length - 1] = {
      ...draftEvent,
      payload: {
        ...draftEvent.payload,
        draftArtifact: forgedArtifact,
        publicationBinding: createPublicationApprovalBinding({
          draftHash: forgedSha256,
          evaluation: draftEvent.payload.evaluation,
          publicationTarget: draftEvent.payload.publicationTarget,
        }),
      },
    };

    expect(() => reduceRunEvents(events)).toThrow(IllegalRunEventError);
    expect(() => reduceRunEvents(events)).toThrow(
      /Learning Artifact draft 与 Evidence 或审批绑定不一致/,
    );
  });

  it("rolls back a Journal artifact reference when no matching private registry row is supplied", async () => {
    const runtimeHome = await createTemporaryDirectory("artifact-registry-");
    const store = new SqliteRunStore(runtimeHome);
    const runId = "run-artifact-registry";
    const sourceScope: SourceScope = {
      roots: [
        {
          canonicalPath: "/private/test-source",
          device: "10",
          inode: "20",
        },
      ],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 4_096,
      maxTotalBytes: 4_096,
    };
    const planHash = "a".repeat(64);
    const budget = runBudget();
    const planArtifact = {
      artifactId: `sha256:${planHash}`,
      sha256: planHash,
      mediaType: "application/json",
      byteLength: 1,
      relativePath: `artifacts/sha256/aa/${planHash}.json`,
    } as const;

    try {
      store.appendEvents(runId, 0, [
        {
          eventId: "event-registry-001",
          runId,
          sequence: 1,
          type: "run_created",
          occurredAt: "2026-08-12T09:10:00.000Z",
          payload: {
            question: "测试 artifact registry 原子对应",
            sourceScope,
            runBudget: budget,
          },
        },
        {
          eventId: "event-registry-002",
          runId,
          sequence: 2,
          type: "planning_started",
          occurredAt: "2026-08-12T09:10:00.000Z",
          payload: {},
        },
      ]);
      expect(() =>
        store.appendEvents(runId, 2, [
          {
            eventId: "event-registry-003",
            runId,
            sequence: 3,
            type: "plan_proposed",
            occurredAt: "2026-08-12T09:10:01.000Z",
            payload: {
              planArtifact,
              approvalBinding: createPlanApprovalBinding({
                question: "测试 artifact registry 原子对应",
                planHash,
                sourceScope,
                runBudget: budget,
              }),
            },
          },
        ]),
      ).toThrowError(
        expect.objectContaining({ name: "ArtifactEventInvariantError" }),
      );
      expect(store.readProjection(runId).lastEventSequence).toBe(2);
    } finally {
      store.close();
    }
  });
});

async function createEvidenceReadyRun(options: {
  /** 是否把成功来源读取继续登记为 Evidence 与 Claim。 */
  readonly recordEvidenceAndClaim?: boolean;
  /** Scripted Model 尝试选择的 Claim identities；测试可借此模拟伪造引用。 */
  readonly proposalClaimIds?: readonly string[];
  /** Scripted Model 提交的标题；可验证 renderer 不接纳预渲染 citation。 */
  readonly proposalTitle?: string;
  /** Scripted Model 提交的摘要；可验证 renderer 不接纳预渲染 citation。 */
  readonly proposalSummary?: string;
  /** 覆盖默认预算的一部分，以证明 Gate 使用整个已批准 Run Budget。 */
  readonly runBudget?: Partial<RunBudget>;
  /** 可替换第二条来源的完整字节，以验证 distinct source 以 Snapshot identity 去重。 */
  readonly otherSourceText?: string;
  /** 测试可注入的 UTC Clock；用于将 research 执行窗口与人工 approval 分离。 */
  readonly clock?: Clock;
} = {}): Promise<{
  /** 当前测试仍持有、可继续提出 draft 的 Runtime。 */
  readonly runtime: ResearchAgentRuntime;
  /** 完成计划审批的 durable Run identity。 */
  readonly runId: string;
  /** 私有 Journal、Projection 与 CAS 所在的 Runtime Home。 */
  readonly runtimeHome: string;
  /** 用户可发布 Markdown 的受控临时目录。 */
  readonly outputDirectory: string;
  /** 成功读取发生后仍可改变、但不应替代 immutable Snapshot 的 live Source Root。 */
  readonly sourceRoot: string;
}> {
  const runtimeHome = await createTemporaryDirectory("artifact-runtime-");
  const sourceRoot = await createTemporaryDirectory("artifact-source-");
  const outputDirectory = await createTemporaryDirectory("artifact-output-");
  await writeFile(
    join(sourceRoot, "source.md"),
    "title\nRun Journal 是 canonical history。\nProjection 可从 Journal 重建。\n",
    "utf8",
  );
  await writeFile(
    join(sourceRoot, "other.md"),
    options.otherSourceText ?? "另一份来源。\n",
    "utf8",
  );
  const ids = createIds();
  const clock = options.clock ?? fixedPublicationClock();
  const evaluator = new ScriptedEvaluator();
  const runtime = ResearchAgentRuntime.open({
    runtimeHome,
    outputRoot: outputDirectory,
    clock,
    ids,
    model: new ScriptedModel(
      [
        {
          title: "从来源建立可发布学习工件",
          objectives: ["验证 Evidence Gate"],
          steps: [{ id: "step-001", description: "读取 source.md" }],
        },
      ],
      [
        {
          title: options.proposalTitle ?? "Journal 的可恢复性",
          summary:
            options.proposalSummary ??
            "这个 Learning Artifact 只渲染已登记 Claim 的结构化 Evidence 引用。",
          claimIds: options.proposalClaimIds ?? ["claim-event-007"],
        },
      ],
    ),
    evaluator,
  });
  const waiting = await runtime.createRun({
    question: "为什么 Journal 可以驱动可恢复状态？",
    sourceScope: {
      roots: [sourceRoot],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 4_096,
      maxTotalBytes: 4_096,
    },
    runBudget: runBudget(options.runBudget),
  });
  if (waiting.state.type !== "waiting_plan_approval") {
    throw new Error("测试夹具要求等待计划审批");
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
      startLine: 2,
      endLine: 3,
    },
  });
  if (read.state.type !== "researching") {
    throw new Error("测试夹具要求成功来源读取后继续 researching");
  }
  const observation = read.state.sourceReadObservations[0];
  if (observation?.status !== "succeeded") {
    throw new Error("测试夹具要求成功来源读取 observation");
  }
  if (options.recordEvidenceAndClaim !== false) {
    const evidenced = await runtime.recordEvidence({
      runId: waiting.runId,
      observationId: observation.observationId,
    });
    if (evidenced.state.type !== "researching") {
      throw new Error("测试夹具要求登记 Evidence 后继续 researching");
    }
    const evidence = evidenced.state.evidenceRecords[0];
    if (evidence === undefined) {
      throw new Error("测试夹具要求一个 Evidence Record");
    }
    await runtime.recordClaim({
      runId: waiting.runId,
      kind: "source_fact",
      text: "Run Journal 是 canonical history。",
      evidenceIds: [evidence.evidenceId],
    });
  }
  return {
    runtime,
    runId: waiting.runId,
    runtimeHome,
    outputDirectory,
    sourceRoot,
  };
}

function tamperEvidenceRange(runtimeHome: string, runId: string): void {
  const database = new Database(join(runtimeHome, "runtime.sqlite"));
  try {
    const readRow = database.prepare(
      "SELECT payload_json FROM run_events WHERE run_id = ? AND sequence = 5",
    ).get(runId) as {
      /** 成功 source read 事件载荷的原始 JSON。 */
      readonly payload_json: string;
    } | undefined;
    const evidenceRow = database.prepare(
      "SELECT payload_json FROM run_events WHERE run_id = ? AND sequence = 6",
    ).get(runId) as {
      /** Evidence 事件载荷的原始 JSON。 */
      readonly payload_json: string;
    } | undefined;
    if (readRow === undefined || evidenceRow === undefined) {
      throw new Error("测试夹具要求固定的 read/Evidence 事件");
    }
    const readPayload = JSON.parse(readRow.payload_json) as {
      /** 测试要构造自洽但与 Snapshot bytes 不一致的成功 observation。 */
      observation: Record<string, unknown>;
    };
    const evidencePayload = JSON.parse(evidenceRow.payload_json) as {
      /** 测试要同步伪造、从而绕过仅逐字段 join 的 Evidence Record。 */
      evidence: Record<string, unknown>;
    };
    Object.assign(readPayload.observation, {
      startLine: 1,
      endLine: 2,
      requestHash: hashCanonicalJson({
        rootIndex: 0,
        relativePath: "source.md",
        startLine: 1,
        endLine: 2,
      }),
      excerpt: "Run Journal 是 canonical history。\nProjection 可从 Journal 重建。",
      excerptHash: hashUtf8Text(
        "Run Journal 是 canonical history。\nProjection 可从 Journal 重建。",
      ),
    });
    Object.assign(evidencePayload.evidence, {
      startLine: 1,
      endLine: 2,
      excerptHash: readPayload.observation.excerptHash,
    });
    const update = database.prepare(
      "UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = ?",
    );
    const transaction = database.transaction(() => {
      database.exec("DROP TRIGGER run_events_are_append_only_on_update");
      update.run(JSON.stringify(readPayload), runId, 5);
      update.run(JSON.stringify(evidencePayload), runId, 6);
    });
    transaction();
  } finally {
    database.close();
  }
}

function runBudget(overrides: Partial<RunBudget> = {}): RunBudget {
  return {
    version: "budget-v1",
    maxModelTurns: 4,
    maxToolCalls: 4,
    maxDistinctSources: 2,
    maxSourceBytes: 4_096,
    maxWallTimeMs: 60_000,
    ...overrides,
  };
}

function createIds(startAt = 0): IdGenerator {
  let event = startAt;
  let toolCall = startAt;
  let observation = startAt;
  return {
    nextRunId: () => "run-artifact-001",
    nextEventId: () => `event-${String(++event).padStart(3, "0")}`,
    nextApprovalId: () => "approval-plan-001",
    nextToolCallId: () => `tool-call-${String(++toolCall).padStart(3, "0")}`,
    nextObservationId: () =>
      `observation-${String(++observation).padStart(3, "0")}`,
  };
}

function fixedPublicationClock(): Clock {
  return { now: () => "2026-08-12T18:18:52.000Z" };
}

function createTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then((directory) => {
    temporaryDirectories.push(directory);
    return directory;
  });
}
