import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ModelViewTooLargeError,
  ResearchAgentRuntime,
  ResearchLoopError,
  ScriptedModel,
} from "../../src/index.js";
import type {
  Clock,
  IdGenerator,
  OpenRuntimeOptions,
  ResearchLoopLifecycleHooks,
  ResearchRunEvent,
  ResearchToolIntent,
  RunBudget,
  SourceSearchPort,
} from "../../src/index.js";
import { IllegalRunEventError } from "../../src/domain/reducer.js";
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
      expect(model.researchViews[1]?.recentObservations[0]).toMatchObject({
        summary: "找到 1 个批准来源命中",
        output: {
          matches: [expect.objectContaining({ relativePath: "journal.md" })],
        },
      });
      expect(model.researchViews[3]?.relevantEvidence[0]).toMatchObject({
        evidenceId: "evidence-event-010",
        excerpt: "Run Journal 是 canonical history。\nProjection 可以从 Journal 重建。",
      });
      expect(model.researchViews[4]).not.toHaveProperty("events");
      expect(model.researchViews[4]).not.toHaveProperty("messages");

      const publicationWaiting = await runtime.proposeLearningArtifact({
          runId: waiting.runId,
          targetPath: join(outputRoot, "journal-learning.md"),
        });
      expect(publicationWaiting).toMatchObject({
        state: {
          type: "waiting_publication_approval",
          researchOrigin: "research_loop",
          completion: { unresolvedQuestions: [] },
        },
      });
      const missingCompletion = structuredClone(publicationWaiting) as unknown as Record<
        string,
        unknown
      >;
      const missingCompletionState = missingCompletion.state;
      if (
        typeof missingCompletionState !== "object" ||
        missingCompletionState === null
      ) {
        throw new Error("测试要求 publication state object");
      }
      delete (missingCompletionState as Record<string, unknown>).completion;
      expect(() => parseRunProjection(missingCompletion)).toThrow();

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

  it("stores search matches only in an Artifact while rebuilding them into the next Model View", async () => {
    const calls: string[] = [];
    const sourceSearch: SourceSearchPort = {
      search: async (_scope, request) => {
        calls.push(request.query);
        return [{
          rootIndex: 0,
          relativePath: "journal.md",
          lineNumber: 1,
          lineText: "injected search body",
        }];
      },
    };
    const fixture = await createApprovedLoopRun(
      [
        turn("search", "search_sources", { query: "injected", maxResults: 1 }),
        turn("complete", "complete_research", { unresolvedQuestions: [] }),
      ],
      {},
      { sourceSearch },
    );
    try {
      const completed = await fixture.runtime.advanceResearch({
        runId: fixture.runId,
      });
      expect(calls).toEqual(["injected"]);
      expect(completed.state).toMatchObject({
        type: "research_complete",
        researchToolObservations: [
          {
            toolName: "search_sources",
            status: "succeeded",
            output: {
              searchResultArtifact: expect.objectContaining({
                mediaType: "application/json",
              }),
              matchCount: 1,
            },
          },
          expect.objectContaining({ toolName: "complete_research" }),
        ],
      });
      expect(JSON.stringify(completed)).not.toContain("injected search body");
      expect(fixture.model.researchViews[1]?.recentObservations[0]).toMatchObject({
        output: {
          matches: [{
            relativePath: "journal.md",
            lineText: "injected search body",
          }],
        },
      });
      expect(JSON.stringify(await fixture.runtime.traceRun({ runId: fixture.runId })))
        .not.toContain("injected search body");
    } finally {
      fixture.runtime.close();
    }
  });

  it("turns an injected source-search failure into a safe observation for the next turn", async () => {
    const sourceSearch: SourceSearchPort = {
      search: async () => {
        throw new Error("private /absolute/path must not escape");
      },
    };
    const fixture = await createApprovedLoopRun(
      [
        turn("search", "search_sources", { query: "canonical", maxResults: 1 }),
        turn("complete", "complete_research", {
          unresolvedQuestions: ["search unavailable"],
        }),
      ],
      {},
      { sourceSearch },
    );
    try {
      const completed = await fixture.runtime.advanceResearch({
        runId: fixture.runId,
      });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        researchToolObservations: [
          expect.objectContaining({
            toolName: "search_sources",
            status: "failed",
            code: "search_failed",
          }),
          expect.objectContaining({ toolName: "complete_research" }),
        ],
      });
      expect(fixture.model.researchViews[1]?.recentObservations).toEqual([
        expect.objectContaining({ code: "search_failed" }),
      ]);
      expect(JSON.stringify(completed)).not.toContain("/absolute/path");
    } finally {
      fixture.runtime.close();
    }
  });

  it("executes a durable pending intent after restart before requesting another Model Turn", async () => {
    const fixture = await createApprovedLoopRun([]);
    fixture.runtime.close();
    const store = new SqliteRunStore(fixture.runtimeHome);
    store.appendEvents(fixture.runId, 4, [
      modelTurnCompletedEvent(fixture.runId, 5, [
        {
          intentId: "pending-search",
          name: "search_sources",
          input: { query: "canonical", maxResults: 1 },
        },
      ]),
    ]);
    store.close();

    const searchQueries: string[] = [];
    const restartedModel = new ScriptedModel([], [], [
      turn("complete", "complete_research", { unresolvedQuestions: [] }),
    ]);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
      sourceSearch: {
        search: async (_scope, request) => {
          searchQueries.push(request.query);
          return [];
        },
      },
    });
    try {
      await expect(
        restarted.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "research_complete" } });
      expect(searchQueries).toEqual(["canonical"]);
      expect(restartedModel.researchViews).toHaveLength(1);
      expect(restartedModel.researchViews[0]?.recentObservations).toEqual([
        expect.objectContaining({
          intentId: "pending-search",
          status: "succeeded",
        }),
      ]);
    } finally {
      restarted.close();
    }
  });

  it("recovers a Model Turn committed before an injected interruption without repeating generation", async () => {
    let interruptOnce = true;
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 1 })],
      {},
      {
        researchLoopHooks: {
          afterModelTurnJournalAppend: () => {
            if (interruptOnce) {
              interruptOnce = false;
              throw new Error("interrupt after durable model turn");
            }
          },
        },
      },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
      expect(fixture.model.researchViews).toHaveLength(1);
    } finally {
      fixture.runtime.close();
    }

    const restartedModel = new ScriptedModel([], [], [
      turn("complete", "complete_research", { unresolvedQuestions: [] }),
    ]);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
      sourceSearch: { search: async () => [] },
    });
    try {
      await expect(
        restarted.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "research_complete" } });
      expect(restartedModel.researchViews).toHaveLength(1);
      expect(restartedModel.researchViews[0]?.recentObservations).toEqual([
        expect.objectContaining({ intentId: "search", status: "succeeded" }),
      ]);
      const trace = await restarted.traceRun({ runId: fixture.runId });
      expect(trace.events.filter((event) => event.type === "model_turn_completed"))
        .toHaveLength(2);
    } finally {
      restarted.close();
    }
  });

  it("recovers an orphaned search Artifact by re-executing the still-pending durable intent", async () => {
    let interruptOnce = true;
    let searchCalls = 0;
    const sourceSearch: SourceSearchPort = {
      search: async () => {
        searchCalls += 1;
        return [{
          rootIndex: 0,
          relativePath: "journal.md",
          lineNumber: 1,
          lineText: "canonical history",
        }];
      },
    };
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 1 })],
      {},
      {
        sourceSearch,
        researchLoopHooks: {
          afterSearchResultArtifactWrite: () => {
            if (interruptOnce) {
              interruptOnce = false;
              throw new Error("interrupt after orphan CAS write");
            }
          },
        },
      },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
      const interrupted = await fixture.runtime.inspectRun({
        runId: fixture.runId,
      });
      expect(interrupted.state).toMatchObject({
        type: "researching",
        pendingToolIntents: [expect.objectContaining({ intentId: "search" })],
        researchToolObservations: [],
      });
    } finally {
      fixture.runtime.close();
    }

    const restartedModel = new ScriptedModel([], [], [
      turn("complete", "complete_research", { unresolvedQuestions: [] }),
    ]);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
      sourceSearch,
    });
    try {
      await expect(
        restarted.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "research_complete" } });
      expect(searchCalls).toBe(2);
      expect(restartedModel.researchViews).toHaveLength(1);
      expect(restartedModel.researchViews[0]?.recentObservations[0]).toMatchObject({
        intentId: "search",
        output: { matches: [expect.objectContaining({ relativePath: "journal.md" })] },
      });
    } finally {
      restarted.close();
    }
  });

  it("does not repeat search after its observation committed before an injected interruption", async () => {
    let searchCalls = 0;
    let interruptOnce = true;
    const sourceSearch: SourceSearchPort = {
      search: async () => {
        searchCalls += 1;
        return [];
      },
    };
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 1 })],
      {},
      {
        sourceSearch,
        researchLoopHooks: {
          afterSearchObservationJournalAppend: () => {
            if (interruptOnce) {
              interruptOnce = false;
              throw new Error("interrupt after durable search observation");
            }
          },
        },
      },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
    } finally {
      fixture.runtime.close();
    }

    const restartedModel = new ScriptedModel([], [], [
      turn("complete", "complete_research", { unresolvedQuestions: [] }),
    ]);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
      sourceSearch,
    });
    try {
      await expect(
        restarted.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "research_complete" } });
      expect(searchCalls).toBe(1);
      expect(restartedModel.researchViews[0]?.recentObservations).toEqual([
        expect.objectContaining({ intentId: "search", status: "succeeded" }),
      ]);
    } finally {
      restarted.close();
    }
  });

  it("retries read_source after interruption between Snapshot CAS and Journal commit", async () => {
    let interruptOnce = true;
    const fixture = await createApprovedLoopRun(
      [turn("read", "read_source", {
        rootIndex: 0,
        relativePath: "journal.md",
        startLine: 1,
        endLine: 1,
      })],
      {},
      {
        researchLoopHooks: {
          afterReadSourceSnapshotWrite: () => {
            if (interruptOnce) {
              interruptOnce = false;
              throw new Error("interrupt after orphan Source Snapshot write");
            }
          },
        },
      },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
      await expect(
        fixture.runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "researching",
          pendingToolIntents: [expect.objectContaining({ intentId: "read" })],
          sourceReadObservations: [],
        },
      });
    } finally {
      fixture.runtime.close();
    }

    await writeFile(
      join(fixture.sourceRoot, "journal.md"),
      "Run Projection 从 Journal 重建。\n",
      "utf8",
    );
    const restartedModel = new ScriptedModel([], [], [
      turn("complete", "complete_research", { unresolvedQuestions: [] }),
    ]);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
    });
    try {
      const completed = await restarted.advanceResearch({ runId: fixture.runId });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        sourceReadObservations: [expect.objectContaining({
          status: "succeeded",
          excerpt: "Run Projection 从 Journal 重建。",
        })],
      });
      expect(restartedModel.researchViews).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("does not repeat read_source after its observation committed before interruption", async () => {
    let interruptOnce = true;
    const fixture = await createApprovedLoopRun(
      [turn("read", "read_source", {
        rootIndex: 0,
        relativePath: "journal.md",
        startLine: 1,
        endLine: 1,
      })],
      {},
      {
        researchLoopHooks: {
          afterReadObservationJournalAppend: () => {
            if (interruptOnce) {
              interruptOnce = false;
              throw new Error("interrupt after durable read observation");
            }
          },
        },
      },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
    } finally {
      fixture.runtime.close();
    }

    await writeFile(
      join(fixture.sourceRoot, "journal.md"),
      "这份新内容不能覆盖已提交的 observation。\n",
      "utf8",
    );
    const restartedModel = new ScriptedModel([], [], [
      turn("complete", "complete_research", { unresolvedQuestions: [] }),
    ]);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
    });
    try {
      const completed = await restarted.advanceResearch({ runId: fixture.runId });
      expect(completed.state).toMatchObject({
        type: "research_complete",
        sourceReadObservations: [expect.objectContaining({
          status: "succeeded",
          excerpt: "Run Journal 是 canonical history。",
        })],
      });
      if (completed.state.type !== "research_complete") {
        throw new Error("测试要求 research_complete");
      }
      expect(completed.state.sourceReadObservations).toHaveLength(1);
      expect(completed.state.researchToolObservations.filter(
        (observation) => observation.toolName === "read_source",
      )).toEqual([expect.objectContaining({ status: "succeeded" })]);
    } finally {
      restarted.close();
    }
  });

  it.each(structuredResearchToolRecoveryCases)(
    "retries $toolName after interruption before its Journal commit",
    async ({ toolName, turns, intentId, collection, beforeHook }) => {
      const fixture = await createApprovedLoopRun(turns, {}, {
        researchLoopHooks: lifecycleInterrupt(
          beforeHook,
          `interrupt before ${toolName} commit`,
        ),
      });
      try {
        await expect(
          fixture.runtime.advanceResearch({ runId: fixture.runId }),
        ).rejects.toBeInstanceOf(ResearchLoopError);
        const interrupted = await fixture.runtime.inspectRun({
          runId: fixture.runId,
        });
        if (interrupted.state.type !== "researching") {
          throw new Error("测试要求 researching");
        }
        expect(interrupted.state.pendingToolIntents).toEqual([
          expect.objectContaining({ intentId }),
        ]);
        expect(interrupted.state[collection]).toEqual([]);
      } finally {
        fixture.runtime.close();
      }

      const { runtime: restarted, model: restartedModel } = restartLoop(fixture);
      try {
        const completed = await restarted.advanceResearch({ runId: fixture.runId });
        if (completed.state.type !== "research_complete") {
          throw new Error("测试要求 research_complete");
        }
        expect(completed.state[collection]).toHaveLength(1);
        expect(restartedModel.researchViews).toHaveLength(1);
      } finally {
        restarted.close();
      }
    },
  );

  it.each(structuredResearchToolRecoveryCases)(
    "does not repeat $toolName after its Journal event committed",
    async ({ toolName, turns, collection, afterHook }) => {
      const fixture = await createApprovedLoopRun(turns, {}, {
        researchLoopHooks: lifecycleInterrupt(
          afterHook,
          `interrupt after ${toolName} commit`,
        ),
      });
      try {
        await expect(
          fixture.runtime.advanceResearch({ runId: fixture.runId }),
        ).rejects.toBeInstanceOf(ResearchLoopError);
      } finally {
        fixture.runtime.close();
      }

      const { runtime: restarted } = restartLoop(fixture);
      try {
        const completed = await restarted.advanceResearch({ runId: fixture.runId });
        if (completed.state.type !== "research_complete") {
          throw new Error("测试要求 research_complete");
        }
        expect(completed.state[collection]).toHaveLength(1);
        expect(completed.state.researchToolObservations.filter(
          (observation) => observation.toolName === toolName,
        )).toEqual([expect.objectContaining({ status: "succeeded" })]);
      } finally {
        restarted.close();
      }
    },
  );

  it("retries complete_research after interruption before its Journal commit", async () => {
    let interruptOnce = true;
    const fixture = await createApprovedLoopRun(
      [turn("complete", "complete_research", { unresolvedQuestions: [] })],
      {},
      {
        researchLoopHooks: {
          beforeCompletionJournalAppend: () => {
            if (interruptOnce) {
              interruptOnce = false;
              throw new Error("interrupt before completion commit");
            }
          },
        },
      },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
      await expect(
        fixture.runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "researching",
          pendingToolIntents: [expect.objectContaining({ intentId: "complete" })],
        },
      });
    } finally {
      fixture.runtime.close();
    }

    const restartedModel = new ScriptedModel([], [], []);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
    });
    try {
      await expect(
        restarted.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "research_complete" } });
      expect(restartedModel.researchViews).toEqual([]);
    } finally {
      restarted.close();
    }
  });

  it("atomically commits completion and budget exhaustion before post-commit interruption", async () => {
    let interruptOnce = true;
    const fixture = await createApprovedLoopRun(
      [turn("complete", "complete_research", { unresolvedQuestions: [] })],
      { maxModelTurns: 2 },
      {
        researchLoopHooks: {
          afterCompletionJournalAppend: () => {
            if (interruptOnce) {
              interruptOnce = false;
              throw new Error("interrupt after completion batch commit");
            }
          },
        },
      },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
      await expect(
        fixture.runtime.inspectRun({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "budget_exhausted",
          researchOutcome: "research_complete",
          exhaustedDimension: "model_turns",
          completion: { unresolvedQuestions: [] },
        },
      });
      const trace = await fixture.runtime.traceRun({ runId: fixture.runId });
      expect(trace.events.slice(-2).map((event) => event.type)).toEqual([
        "research_completed",
        "run_budget_exhausted",
      ]);
    } finally {
      fixture.runtime.close();
    }

    const restartedModel = new ScriptedModel([], [], []);
    const restarted = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model: restartedModel,
      clock: fixedClock(),
      ids: sequentialIds(100),
    });
    try {
      await expect(
        restarted.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "budget_exhausted" } });
      expect(restartedModel.researchViews).toEqual([]);
    } finally {
      restarted.close();
    }
  });

  it("rejects a generic success observation that tries to impersonate read_source", async () => {
    const fixture = await createApprovedLoopRun([]);
    fixture.runtime.close();
    const store = new SqliteRunStore(fixture.runtimeHome);
    try {
      store.appendEvents(fixture.runId, 4, [
        modelTurnCompletedEvent(fixture.runId, 5, [
          {
            intentId: "read",
            name: "read_source",
            input: {
              rootIndex: 0,
              relativePath: "journal.md",
              startLine: 1,
              endLine: 1,
            },
          },
        ]),
      ]);
      expect(() =>
        store.appendEvents(fixture.runId, 5, [{
          eventId: "event-forged-generic-read",
          runId: fixture.runId,
          sequence: 6,
          type: "research_tool_observed",
          occurredAt: fixedClock().now(),
          payload: {
            observation: {
              observationId: "observation-forged-read",
              toolCallId: "tool-call-forged-read",
              intentId: "read",
              toolName: "read_source",
              status: "succeeded",
              summary: "forged read success",
              output: { sourceObservationId: "observation-forged-read" },
              observedAt: fixedClock().now(),
            },
          },
        }]),
      ).toThrow(IllegalRunEventError);
      expect(store.readProjection(fixture.runId).lastEventSequence).toBe(5);
    } finally {
      store.close();
    }
  });

  it("rejects replay of a Research Tool observation beyond the approved tool budget", async () => {
    const fixture = await createApprovedLoopRun([], { maxToolCalls: 1 });
    fixture.runtime.close();
    const store = new SqliteRunStore(fixture.runtimeHome);
    try {
      store.appendEvents(fixture.runId, 4, [
        modelTurnCompletedEvent(fixture.runId, 5, [
          { intentId: "first", name: "search_sources", input: {} },
          { intentId: "second", name: "search_sources", input: {} },
        ]),
      ]);
      store.appendEvents(fixture.runId, 5, [
        invalidSearchObservationEvent(fixture.runId, 6, "first"),
      ]);
      expect(() =>
        store.appendEvents(fixture.runId, 6, [
          invalidSearchObservationEvent(fixture.runId, 7, "second"),
        ]),
      ).toThrow(/tool call 限制/);
      expect(store.readProjection(fixture.runId).lastEventSequence).toBe(6);
    } finally {
      store.close();
    }
  });

  it("does not allow a draft after entering the Research Loop until complete_research succeeds", async () => {
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 1 })],
      {},
      {
        learningArtifactProposals: [{
          title: "must not be generated",
          summary: "Research completion is mandatory.",
          claimIds: ["claim-event-007"],
        }],
      },
    );
    try {
      const read = await fixture.runtime.readSource({
        runId: fixture.runId,
        request: {
          rootIndex: 0,
          relativePath: "journal.md",
          startLine: 1,
          endLine: 1,
        },
      });
      if (read.state.type !== "researching" || read.state.sourceReadObservations[0] === undefined) {
        throw new Error("测试要求成功来源 observation");
      }
      const evidenced = await fixture.runtime.recordEvidence({
        runId: fixture.runId,
        observationId: read.state.sourceReadObservations[0].observationId,
      });
      if (evidenced.state.type !== "researching" || evidenced.state.evidenceRecords[0] === undefined) {
        throw new Error("测试要求 Evidence Record");
      }
      await fixture.runtime.recordClaim({
        runId: fixture.runId,
        kind: "source_fact",
        text: "Run Journal 是 canonical history。",
        evidenceIds: [evidenced.state.evidenceRecords[0].evidenceId],
      });
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).rejects.toBeInstanceOf(ResearchLoopError);
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputRoot, "incomplete.md"),
        }),
      ).rejects.toThrow(/状态不能提出/);
      expect(fixture.model.learningArtifactRequests).toEqual([]);
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

  it("persists budget exhaustion from the same clock instant used by reducer replay", async () => {
    let tick = 0;
    const clock: Clock = {
      now: () =>
        new Date(Date.UTC(2026, 7, 12, 8, 0, 0, tick++)).toISOString(),
    };
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 5 })],
      { maxModelTurns: 2, maxWallTimeMs: 60_000 },
      { clock },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "budget_exhausted",
          exhaustedDimension: "model_turns",
        },
      });
      await expect(
        fixture.runtime.rebuildRunProjection({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "budget_exhausted" } });
    } finally {
      fixture.runtime.close();
    }
  });

  it("recomputes the exhausted dimension when wall time overtakes model turns", async () => {
    let clockCalls = 0;
    const clock: Clock = {
      now: () =>
        clockCalls++ < 6
          ? "2026-08-12T08:00:00.000Z"
          : "2026-08-12T08:00:00.001Z",
    };
    const fixture = await createApprovedLoopRun(
      [turn("search", "search_sources", { query: "canonical", maxResults: 5 })],
      { maxModelTurns: 2, maxWallTimeMs: 1 },
      { clock },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "budget_exhausted",
          exhaustedDimension: "wall_time",
          remainingBudget: {
            modelTurns: 0,
            wallTimeMs: 0,
          },
        },
      });
      await expect(
        fixture.runtime.rebuildRunProjection({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "budget_exhausted",
          exhaustedDimension: "wall_time",
        },
      });
    } finally {
      fixture.runtime.close();
    }
  });

  it("suspends after explicit completion when the final Model Turn exhausts the budget", async () => {
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
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "budget_exhausted",
          exhaustedDimension: "model_turns",
        },
      });
      await expect(
        fixture.runtime.proposeLearningArtifact({
          runId: fixture.runId,
          targetPath: join(fixture.outputRoot, "must-not-call-model.md"),
        }),
      ).rejects.toThrow(/状态不能提出/);
      expect(fixture.model.learningArtifactRequests).toEqual([]);
    } finally {
      fixture.runtime.close();
    }
  });

  it("suspends when completion processing exhausts the Research Loop wall-time budget", async () => {
    let clockCalls = 0;
    const clock: Clock = {
      now: () =>
        clockCalls++ < 6
          ? "2026-08-12T08:00:00.000Z"
          : "2026-08-12T08:00:00.010Z",
    };
    const fixture = await createApprovedLoopRun(
      [turn("complete", "complete_research", { unresolvedQuestions: [] })],
      { maxWallTimeMs: 1 },
      { clock },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({
        state: {
          type: "budget_exhausted",
          researchOutcome: "research_complete",
          exhaustedDimension: "wall_time",
          completion: { unresolvedQuestions: [] },
        },
      });
    } finally {
      fixture.runtime.close();
    }
  });

  it("does not charge idle time after research completed within the wall-time budget", async () => {
    let clockCalls = 0;
    const clock: Clock = {
      now: () =>
        clockCalls++ < 7
          ? "2026-08-12T08:00:00.000Z"
          : "2026-08-12T10:00:00.000Z",
    };
    const fixture = await createApprovedLoopRun(
      [turn("complete", "complete_research", { unresolvedQuestions: [] })],
      { maxWallTimeMs: 1 },
      { clock },
    );
    try {
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "research_complete" } });
      await expect(
        fixture.runtime.advanceResearch({ runId: fixture.runId }),
      ).resolves.toMatchObject({ state: { type: "research_complete" } });
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

const structuredResearchToolRecoveryCases = [
  {
    toolName: "record_evidence",
    intentId: "evidence",
    collection: "evidenceRecords",
    beforeHook: "beforeEvidenceJournalAppend",
    afterHook: "afterEvidenceJournalAppend",
    turns: [
      turn("read", "read_source", {
        rootIndex: 0,
        relativePath: "journal.md",
        startLine: 1,
        endLine: 1,
      }),
      turn("evidence", "record_evidence", { observationId: "observation-001" }),
    ],
  },
  {
    toolName: "propose_claim",
    intentId: "claim",
    collection: "claims",
    beforeHook: "beforeClaimJournalAppend",
    afterHook: "afterClaimJournalAppend",
    turns: [
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
    ],
  },
] as const satisfies readonly {
  /** 本恢复用例覆盖的模型可见 Research Tool。 */
  readonly toolName: "record_evidence" | "propose_claim";
  /** 中断时必须仍由 Projection 暴露的 durable pending intent identity。 */
  readonly intentId: string;
  /** commit 前后用于断言领域事实数量的 Projection collection。 */
  readonly collection: "evidenceRecords" | "claims";
  /** 领域 Journal event 尚未提交时触发中断的命名 Fault Injection Point。 */
  readonly beforeHook: keyof ResearchLoopLifecycleHooks;
  /** 领域 Journal event 已 durable 提交后触发中断的命名 Fault Injection Point。 */
  readonly afterHook: keyof ResearchLoopLifecycleHooks;
  /** 到达目标工具所需的确定性 Scripted Model turns。 */
  readonly turns: ConstructorParameters<typeof ScriptedModel>[2];
}[];

function lifecycleInterrupt(
  hook: keyof ResearchLoopLifecycleHooks,
  message: string,
): ResearchLoopLifecycleHooks {
  let interruptOnce = true;
  return {
    [hook]: () => {
      if (interruptOnce) {
        interruptOnce = false;
        throw new Error(message);
      }
    },
  };
}

function restartLoop(
  fixture: Awaited<ReturnType<typeof createApprovedLoopRun>>,
) {
  const model = new ScriptedModel([], [], [
    turn("complete", "complete_research", { unresolvedQuestions: [] }),
  ]);
  return {
    model,
    runtime: ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      outputRoot: fixture.outputRoot,
      model,
      clock: fixedClock(),
      ids: sequentialIds(100),
    }),
  };
}

function modelTurnCompletedEvent(
  runId: string,
  sequence: number,
  toolIntents: readonly ResearchToolIntent[],
): ResearchRunEvent {
  const eventId = `event-recovery-${sequence}`;
  const occurredAt = fixedClock().now();
  return {
    eventId,
    runId,
    sequence,
    type: "model_turn_completed",
    occurredAt,
    payload: {
      generationStartedAt: occurredAt,
      turn: {
        turnId: `turn-${eventId}`,
        text: "durable pending intent",
        evidenceGaps: [],
        finishReason: "tool_calls",
        toolIntents,
        completedAt: occurredAt,
      },
    },
  };
}

function invalidSearchObservationEvent(
  runId: string,
  sequence: number,
  intentId: string,
): ResearchRunEvent {
  const occurredAt = fixedClock().now();
  return {
    eventId: `event-invalid-search-${sequence}`,
    runId,
    sequence,
    type: "research_tool_observed",
    occurredAt,
    payload: {
      observation: {
        observationId: `observation-invalid-search-${sequence}`,
        toolCallId: `tool-call-invalid-search-${sequence}`,
        intentId,
        toolName: "search_sources",
        status: "invalid",
        code: "invalid_tool_schema",
        summary: "invalid search schema",
        observedAt: occurredAt,
      },
    },
  };
}

async function createApprovedLoopRun(
  turns: ConstructorParameters<typeof ScriptedModel>[2],
  limits: Partial<RunBudget> = {},
  runtimeOptions: Pick<
    OpenRuntimeOptions,
    "maxModelViewBytes" | "clock" | "sourceSearch" | "researchLoopHooks"
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
    ...(runtimeOptions.sourceSearch === undefined
      ? {}
      : { sourceSearch: runtimeOptions.sourceSearch }),
    ...(runtimeOptions.researchLoopHooks === undefined
      ? {}
      : { researchLoopHooks: runtimeOptions.researchLoopHooks }),
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
  return {
    runtime,
    runId: waiting.runId,
    model,
    runtimeHome,
    outputRoot,
    sourceRoot,
  };
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

function sequentialIds(startAt = 0): IdGenerator {
  let event = startAt;
  let toolCall = startAt;
  let observation = startAt;
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
