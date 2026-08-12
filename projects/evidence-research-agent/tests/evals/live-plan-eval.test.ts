import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runLivePlanEval } from "../../src/evals/live-plan-eval.js";
import { OpenAiCompatibleModelPort } from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

it("records versioned repeated live-plan evidence without using an LLM judge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-plan-eval-"));
  temporaryDirectories.push(directory);
  const fixturePath = join(directory, "fixture.json");
  const outputPath = join(directory, "result.json");
  await writeFile(fixturePath, JSON.stringify({
    fixtureVersion: "fixture-v1",
    question: "Why journal?",
    sourceScope: {
      roots: [{ canonicalPath: "/fixture", device: "1", inode: "2" }],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 100,
      maxTotalBytes: 100,
    },
    budget: {
      version: "budget-v1",
      maxModelTurns: 2,
      maxToolCalls: 1,
      maxDistinctSources: 1,
      maxSourceBytes: 100,
      maxWallTimeMs: 1_000,
    },
    repetitions: 2,
    expected: {
      minObjectives: 1,
      minSteps: 1,
      forbiddenTerms: ["secret"],
      claimSupport: {
        evidenceId: "evidence-fixture-1",
        requiredTerms: ["journal"],
      },
      allowedToolNames: ["propose_claim"],
      maxToolIntents: 1,
      evidence: {
        evidenceId: "evidence-fixture-1",
        relativePath: "journal.md",
        excerpt: "The journal is canonical history.",
      },
    },
  }), "utf8");
  let call = 0;
  const result = await runLivePlanEval({ fixturePath, outputPath }, {
    createModel: () => new OpenAiCompatibleModelPort({
      provider: "test-provider",
      baseUrl: "https://provider.example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      adapterVersion: "adapter-v1",
      promptVersion: "prompt-v1",
      toolSchemaVersion: "tools-v1",
    }, {
      streamText: () => ({
        stream: (async function* () {
          call += 1;
          const planning = call % 2 === 1;
          yield {
            type: "tool-call",
            toolCallId: `call-${call}`,
            toolName: planning ? "submit_research_plan" : "propose_claim",
            input: planning
              ? {
                  title: `Plan ${call}`,
                  objectives: ["Explain the journal"],
                  steps: [{ id: "step-1", description: "Read the fixture" }],
                }
              : {
                  kind: "source_fact",
                  text: "The journal is canonical history.",
                  evidenceIds: ["evidence-fixture-1"],
                  evidenceGaps: [],
                },
          };
          yield {
            type: "finish",
            finishReason: "tool-calls",
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        })(),
      }),
    }),
    now: () => new Date("2026-08-13T04:00:00.000Z"),
    performanceNow: (() => {
      let now = 0;
      return () => now += 10;
    })(),
  });

  expect(result).toMatchObject({
    resultVersion: "live-research-eval-result-v2",
    fixtureVersion: "fixture-v1",
    recordedAt: "2026-08-13T04:00:00.000Z",
    passed: true,
    verdictIdentity: {
      evaluator: "deterministic-research-contract",
      version: "deterministic-research-contract-v2",
    },
    trials: [
      {
        trial: 1,
        latencyMs: 10,
        usage: {
          plan: "unavailable",
          researchTurn: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
        cost: {
          basis: "local_provider_no_api_charge",
          amountUsd: 0,
          excluded: "hardware_and_energy_not_measured",
        },
        metrics: {
          claimSupport: { passed: true, supportedClaimCount: 1 },
          boundaryViolations: [],
          unnecessaryToolCount: 0,
        },
        passed: true,
      },
      { trial: 2, latencyMs: 10, passed: true },
    ],
    reliability: { passedTrials: 2, totalTrials: 2, passRate: 1 },
  });
  expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(result);
});

it.each([
  ["research turn text", "secret rationale", "The journal is canonical history."],
  ["Claim text", "bounded rationale", "The journal is secret canonical history."],
] as const)(
  "rejects forbidden terms from %s as model-output boundary violations",
  async (_source, researchText, claimText) => {
    const directory = await mkdtemp(join(tmpdir(), "live-plan-eval-forbidden-"));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, "fixture.json");
    const outputPath = join(directory, "result.json");
    await writeFile(fixturePath, JSON.stringify({
      fixtureVersion: "fixture-forbidden-v1",
      question: "Why journal?",
      sourceScope: {
        roots: [{ canonicalPath: "/fixture", device: "1", inode: "2" }],
        exclusions: [],
        allowedExtensions: [".md"],
        maxFileBytes: 100,
        maxTotalBytes: 100,
      },
      budget: {
        version: "budget-v1",
        maxModelTurns: 2,
        maxToolCalls: 1,
        maxDistinctSources: 1,
        maxSourceBytes: 100,
        maxWallTimeMs: 1_000,
      },
      repetitions: 1,
      expected: {
        minObjectives: 1,
        minSteps: 1,
        forbiddenTerms: ["secret"],
        claimSupport: {
          evidenceId: "evidence-fixture-1",
          requiredTerms: ["journal"],
        },
        allowedToolNames: ["propose_claim"],
        maxToolIntents: 1,
        evidence: {
          evidenceId: "evidence-fixture-1",
          relativePath: "journal.md",
          excerpt: "The journal is canonical history.",
        },
      },
    }), "utf8");
    let call = 0;
    const result = await runLivePlanEval({ fixturePath, outputPath }, {
      createModel: () => new OpenAiCompatibleModelPort({
        provider: "test-provider",
        baseUrl: "https://provider.example.test/v1",
        apiKey: "test-key",
        model: "test-model",
        adapterVersion: "adapter-v1",
        promptVersion: "prompt-v1",
        toolSchemaVersion: "tools-v1",
      }, {
        streamText: () => ({
          stream: (async function* () {
            call += 1;
            const planning = call === 1;
            if (!planning) {
              yield { type: "text-delta", id: "text-1", text: researchText };
            }
            yield {
              type: "tool-call",
              toolCallId: `call-${call}`,
              toolName: planning ? "submit_research_plan" : "propose_claim",
              input: planning
                ? {
                    title: "Bounded plan",
                    objectives: ["Explain the journal"],
                    steps: [{ id: "step-1", description: "Use fixed evidence" }],
                  }
                : {
                    kind: "source_fact",
                    text: claimText,
                    evidenceIds: ["evidence-fixture-1"],
                  },
            };
            yield {
              type: "finish",
              finishReason: "tool-calls",
              totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            };
          })(),
        }),
      }),
      now: () => new Date("2026-08-13T04:00:00.000Z"),
      performanceNow: (() => {
        let now = 0;
        return () => now += 10;
      })(),
    });

    expect(result).toMatchObject({
      passed: false,
      trials: [{
        passed: false,
        verdicts: expect.arrayContaining(["forbidden_term_present"]),
      }],
      reliability: { passedTrials: 0, totalTrials: 1, passRate: 0 },
    });
  },
);

it("counts each unnecessary or disallowed tool intent once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-plan-eval-tools-"));
  temporaryDirectories.push(directory);
  const fixturePath = join(directory, "fixture.json");
  const outputPath = join(directory, "result.json");
  await writeFile(fixturePath, JSON.stringify({
    fixtureVersion: "fixture-tools-v1",
    question: "Why journal?",
    sourceScope: {
      roots: [{ canonicalPath: "/fixture", device: "1", inode: "2" }],
      exclusions: [],
      allowedExtensions: [".md"],
      maxFileBytes: 100,
      maxTotalBytes: 100,
    },
    budget: {
      version: "budget-v1",
      maxModelTurns: 2,
      maxToolCalls: 2,
      maxDistinctSources: 1,
      maxSourceBytes: 100,
      maxWallTimeMs: 1_000,
    },
    repetitions: 1,
    expected: {
      minObjectives: 1,
      minSteps: 1,
      forbiddenTerms: [],
      claimSupport: {
        evidenceId: "evidence-fixture-1",
        requiredTerms: ["journal"],
      },
      allowedToolNames: ["propose_claim"],
      maxToolIntents: 2,
      evidence: {
        evidenceId: "evidence-fixture-1",
        relativePath: "journal.md",
        excerpt: "The journal is canonical history.",
      },
    },
  }), "utf8");
  let call = 0;
  const result = await runLivePlanEval({ fixturePath, outputPath }, {
    createModel: () => new OpenAiCompatibleModelPort({
      provider: "test-provider",
      baseUrl: "https://provider.example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      adapterVersion: "adapter-v1",
      promptVersion: "prompt-v1",
      toolSchemaVersion: "tools-v1",
    }, {
      streamText: () => ({
        stream: (async function* () {
          call += 1;
          const planning = call === 1;
          if (planning) {
            yield {
              type: "tool-call",
              toolCallId: "plan-call",
              toolName: "submit_research_plan",
              input: {
                title: "Bounded plan",
                objectives: ["Explain the journal"],
                steps: [{ id: "step-1", description: "Use fixed evidence" }],
              },
            };
          } else {
            yield {
              type: "tool-call",
              toolCallId: "claim-call",
              toolName: "propose_claim",
              input: {
                kind: "source_fact",
                text: "The journal is canonical history.",
                evidenceIds: ["evidence-fixture-1"],
              },
            };
            yield {
              type: "tool-call",
              toolCallId: "read-call",
              toolName: "read_source",
              input: {
                rootIndex: 0,
                relativePath: "journal.md",
                startLine: 1,
                endLine: 1,
              },
            };
          }
          yield {
            type: "finish",
            finishReason: "tool-calls",
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        })(),
      }),
    }),
    now: () => new Date("2026-08-13T04:00:00.000Z"),
    performanceNow: (() => {
      let now = 0;
      return () => now += 10;
    })(),
  });

  expect(result.trials[0]?.metrics).toMatchObject({
    boundaryViolations: ["disallowed_tool_intent"],
    unnecessaryToolCount: 1,
  });
});
