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
      maxModelTurns: 1,
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
          yield {
            type: "tool-call",
            toolCallId: `call-${call}`,
            toolName: "submit_research_plan",
            input: {
              title: `Plan ${call}`,
              objectives: ["Explain the journal"],
              steps: [{ id: "step-1", description: "Read the fixture" }],
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
    resultVersion: "live-plan-eval-result-v1",
    fixtureVersion: "fixture-v1",
    recordedAt: "2026-08-13T04:00:00.000Z",
    passed: true,
    verdictIdentity: {
      evaluator: "deterministic-plan-contract",
      version: "deterministic-plan-contract-v1",
    },
    trials: [
      {
        trial: 1,
        latencyMs: 10,
        usage: "unavailable",
        cost: {
          basis: "local_provider_no_api_charge",
          amountUsd: 0,
          excluded: "hardware_and_energy_not_measured",
        },
        passed: true,
      },
      { trial: 2, latencyMs: 10, passed: true },
    ],
  });
  expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(result);
});
