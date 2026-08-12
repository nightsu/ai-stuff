import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import {
  InfrastructureFailureError,
  createOpenAiCompatibleModelPortFromEnv,
  ModelGenerationAbortedError,
  OpenAiCompatibleModelPort,
} from "../../src/index.js";
import type {
  AiSdkStreamPart,
  AiSdkStreamTextOptions,
  OpenAiCompatibleModelDependencies,
} from "../../src/adapters/openai-compatible-model.js";
import type { ModelView } from "../../src/index.js";

describe("OpenAI-compatible Model Port contract", () => {
  it("assembles streamed text and tool arguments into one completed Model Turn", async () => {
    const abortController = new AbortController();
    let receivedOptions: AiSdkStreamTextOptions | undefined;
    const model = new OpenAiCompatibleModelPort(
      {
        provider: "local-openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "contract-secret",
        model: "research-model",
        adapterVersion: "adapter-v1",
        promptVersion: "prompt-v1",
        toolSchemaVersion: "tools-v1",
      },
      {
        streamText: (options) => {
          receivedOptions = options;
          return {
            stream: stream([
              { type: "text-delta", id: "text-1", text: "先" },
              { type: "text-delta", id: "text-1", text: "搜索" },
              {
                type: "tool-input-start",
                id: "call-1",
                toolName: "search_sources",
              },
              {
                type: "tool-input-delta",
                id: "call-1",
                delta: '{"query":"Run Journal",',
              },
              {
                type: "tool-input-delta",
                id: "call-1",
                delta: '"maxResults":5,"evidenceGaps":["缺少原文"]}',
              },
              { type: "tool-input-end", id: "call-1" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "search_sources",
                input: {
                  query: "Run Journal",
                  maxResults: 5,
                  evidenceGaps: ["缺少原文"],
                },
              },
              {
                type: "finish",
                finishReason: "tool-calls",
                rawFinishReason: "tool_calls",
                totalUsage: {
                  inputTokens: 41,
                  inputTokenDetails: {
                    noCacheTokens: 41,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  },
                  outputTokens: 17,
                  outputTokenDetails: {
                    textTokens: 6,
                    reasoningTokens: 11,
                  },
                  totalTokens: 58,
                },
              },
            ]),
          };
        },
      },
    );

    await expect(
      model.generateResearchTurn(modelView(), {
        abortSignal: abortController.signal,
      }),
    ).resolves.toEqual({
      text: "先搜索",
      evidenceGaps: ["缺少原文"],
      finishReason: "tool_calls",
      toolIntents: [
        {
          intentId: "call-1",
          name: "search_sources",
          input: { query: "Run Journal", maxResults: 5 },
        },
      ],
      usage: {
        inputTokens: 41,
        outputTokens: 17,
        totalTokens: 58,
        cachedInputTokens: 0,
        reasoningTokens: 11,
      },
    });

    expect(receivedOptions?.abortSignal).toBe(abortController.signal);
    expect(receivedOptions?.maxRetries).toBe(0);
    expect(receivedOptions).not.toHaveProperty("stopWhen");
    const tools = receivedOptions?.tools as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.values(tools).every((tool) => !("execute" in tool))).toBe(
      true,
    );
  });

  it.each([
    { statusCode: 429, code: "rate_limited", retryAfter: "2", retryAfterMs: 2_000 },
    { statusCode: 500, code: "service_unavailable" },
    { statusCode: 504, code: "request_timeout" },
    { statusCode: undefined, code: "connection_failed" },
  ] as const)(
    "normalizes provider failure $statusCode as $code without leaking payloads",
    async ({ statusCode, code, retryAfter, retryAfterMs }) => {
      const secret = "provider-secret-must-not-leak";
      const model = contractModel(() => {
        throw new APICallError({
          message: `provider rejected ${secret}`,
          url: `https://provider.invalid/v1?api_key=${secret}`,
          requestBodyValues: { authorization: secret },
          ...(statusCode === undefined ? {} : { statusCode }),
          ...(retryAfter === undefined
            ? {}
            : { responseHeaders: { "retry-after": retryAfter } }),
          responseBody: JSON.stringify({ error: secret }),
          isRetryable: statusCode === undefined || statusCode >= 500 || statusCode === 429,
        });
      });

      const error = await model.generateResearchTurn(modelView()).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(InfrastructureFailureError);
      expect(error).toMatchObject({ code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    },
  );

  it("normalizes an HTTP-date Retry-After with an injected deterministic clock", async () => {
    const nowMs = Date.parse("2026-08-12T10:00:00.000Z");
    const model = new OpenAiCompatibleModelPort(
      liveConfig("contract-secret"),
      {
        streamText: () => {
          throw new APICallError({
            message: "rate limited",
            url: "https://provider.invalid/v1",
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: {
              "retry-after": "Wed, 12 Aug 2026 10:00:05 GMT",
            },
            responseBody: "{}",
            isRetryable: true,
          });
        },
        nowMs: () => nowMs,
      },
    );

    await expect(model.generateResearchTurn(modelView())).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 5_000,
    });
  });

  it("cancels a partial stream without returning a completed result", async () => {
    const controller = new AbortController();
    const model = contractModel((options) => ({
      stream: (async function* () {
        yield { type: "text-delta", id: "text-1", text: "partial secret" };
        controller.abort();
        expect(options.abortSignal?.aborted).toBe(true);
        yield { type: "abort", reason: "user-cancelled" };
      })(),
    }));

    await expect(
      model.generateResearchTurn(modelView(), {
        abortSignal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ModelGenerationAbortedError);
  });

  it("loads provider configuration from environment while exposing only non-secret identity", () => {
    const secret = "environment-secret";
    const model = createOpenAiCompatibleModelPortFromEnv({
      EVIDENCE_MODEL_PROVIDER: "team-gateway",
      EVIDENCE_MODEL_BASE_URL: "https://models.example.test/v1",
      EVIDENCE_MODEL_API_KEY: secret,
      EVIDENCE_MODEL_NAME: "research-large",
      EVIDENCE_MODEL_ADAPTER_VERSION: "adapter-v7",
      EVIDENCE_MODEL_PROMPT_VERSION: "prompt-v3",
      EVIDENCE_MODEL_TOOL_SCHEMA_VERSION: "tools-v4",
    });

    expect(model.experimentIdentity).toEqual({
      provider: "team-gateway",
      model: "research-large",
      adapterVersion: "adapter-v7",
      promptVersion: "prompt-v3",
      toolSchemaVersion: "tools-v4",
    });
    expect(JSON.stringify(model.experimentIdentity)).not.toContain(secret);
    expect(JSON.stringify(model)).not.toContain(secret);
  });

  it("implements plan and Learning Artifact proposal through schema-only streamed tool calls", async () => {
    const optionSnapshots: AiSdkStreamTextOptions[] = [];
    const responses: AiSdkStreamPart[][] = [
      [
        {
          type: "tool-call",
          toolCallId: "plan-call",
          toolName: "submit_research_plan",
          input: {
            title: "研究 Run Journal",
            objectives: ["验证 canonical history"],
            steps: [{ id: "step-1", description: "定位来源" }],
          },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "artifact-call",
          toolName: "submit_learning_artifact",
          input: {
            title: "Run Journal",
            summary: "只组织已有 Claims。",
            claimIds: ["claim-1"],
          },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
        },
      ],
    ];
    const model = contractModel((options) => {
      optionSnapshots.push(options);
      return { stream: stream(responses.shift() ?? []) };
    });

    await expect(model.proposePlan({
      runId: "run-1",
      question: "Run Journal 是什么？",
      sourceScope: {
        roots: [{ canonicalPath: "/tmp/source", device: "1", inode: "2" }],
        exclusions: [],
        allowedExtensions: [".md"],
        maxFileBytes: 1_000,
        maxTotalBytes: 10_000,
      },
    })).resolves.toEqual({
      title: "研究 Run Journal",
      objectives: ["验证 canonical history"],
      steps: [{ id: "step-1", description: "定位来源" }],
    });
    await expect(model.proposeLearningArtifact({
      runId: "run-1",
      question: "Run Journal 是什么？",
      claims: [{
        claimId: "claim-1",
        kind: "source_fact",
        text: "Run Journal 是 canonical history。",
        evidenceIds: ["evidence-1"],
        recordedAt: "2026-08-12T09:00:00.000Z",
      }],
      evidenceRecords: [],
    })).resolves.toEqual({
      title: "Run Journal",
      summary: "只组织已有 Claims。",
      claimIds: ["claim-1"],
    });
    expect(optionSnapshots.every((options) =>
      Object.values(options.tools).every((tool) => !("execute" in tool))
    )).toBe(true);
  });

  it("runs Evaluator Review with an isolated prompt, minimal input, and closed verdict schema", async () => {
    let receivedOptions: AiSdkStreamTextOptions | undefined;
    const model = new OpenAiCompatibleModelPort(
      {
        ...liveConfig("evaluator-secret"),
        evaluatorPromptVersion: "evaluator-prompt-v7",
      },
      {
        streamText: (options) => {
          receivedOptions = options;
          return {
            stream: stream([
              {
                type: "tool-call",
                toolCallId: "review-call",
                toolName: "submit_evaluator_review",
                input: {
                  verdicts: [{ claimId: "claim-1", verdict: "uncertain" }],
                },
              },
              {
                type: "finish",
                finishReason: "tool-calls",
                totalUsage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
              },
            ]),
          };
        },
      },
    );
    const request = {
      question: "Run Journal 如何恢复？",
      claims: [{
        claimId: "claim-1",
        kind: "source_fact" as const,
        text: "Run Journal 是 canonical history。",
        evidence: [{
          evidenceId: "evidence-1",
          sourceSnapshotId: `source-sha256:${"a".repeat(64)}`,
          relativePath: "source.md",
          startLine: 2,
          endLine: 2,
          excerpt: "Run Journal 是 canonical history。",
        }],
      }],
    };

    await expect(model.reviewClaims(request)).resolves.toEqual({
      verdicts: [{ claimId: "claim-1", verdict: "uncertain" }],
    });
    expect(model.identity).toEqual({
      provider: "local-openai",
      model: "research-model",
      promptVersion: "evaluator-prompt-v7",
    });
    expect(receivedOptions?.instructions).toContain(
      "Evaluator prompt version: evaluator-prompt-v7",
    );
    expect(receivedOptions?.instructions).toContain(
      "不要推断 Research Loop history",
    );
    expect(receivedOptions?.instructions).not.toContain("Harness 将验证并调度");
    expect(JSON.parse(receivedOptions?.prompt ?? "null")).toEqual(request);
    expect(receivedOptions?.prompt).not.toContain("recentObservations");
    expect(Object.keys(receivedOptions?.tools ?? {})).toEqual([
      "submit_evaluator_review",
    ]);
    const reviewTool = receivedOptions?.tools.submit_evaluator_review as {
      /** AI SDK tool 暴露的结构化 Evaluator verdict 输入 schema。 */
      readonly inputSchema?: {
        /** 在不调用 provider 的情况下验证封闭 verdict contract。 */
        safeParse(input: unknown): {
          /** 输入是否满足 exact Evaluator verdict schema。 */
          readonly success: boolean;
        };
      };
    } | undefined;
    expect(reviewTool?.inputSchema?.safeParse({
      verdicts: [{ claimId: "claim-1", verdict: "supported" }],
    }).success).toBe(true);
    expect(reviewTool?.inputSchema?.safeParse({
      verdicts: [{ claimId: "claim-1", verdict: "approved" }],
    }).success).toBe(false);
    expect(JSON.stringify({
      instructions: receivedOptions?.instructions,
      prompt: receivedOptions?.prompt,
      tools: receivedOptions?.tools,
      identity: model.identity,
    })).not.toContain("evaluator-secret");
  });

  it("does not turn an aborted partial Evaluator stream into a review", async () => {
    const controller = new AbortController();
    const model = contractModel((options) => ({
      stream: (async function* () {
        yield {
          type: "tool-input-start",
          id: "review-call",
          toolName: "submit_evaluator_review",
        };
        yield {
          type: "tool-input-delta",
          id: "review-call",
          delta: '{"verdicts":[{"claimId":"claim-1",',
        };
        controller.abort();
        expect(options.abortSignal?.aborted).toBe(true);
        yield { type: "abort", reason: "user-cancelled" };
      })(),
    }));

    await expect(
      model.reviewClaims(evaluatorRequest(), {
        abortSignal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ModelGenerationAbortedError);
  });

  it("normalizes Evaluator provider failures without leaking provider payloads", async () => {
    const secret = "evaluator-provider-secret";
    const model = new OpenAiCompatibleModelPort(
      liveConfig(secret),
      {
        streamText: () => {
          throw new APICallError({
            message: `review failed ${secret}`,
            url: `https://provider.invalid/v1?api_key=${secret}`,
            requestBodyValues: { authorization: secret },
            statusCode: 500,
            responseBody: JSON.stringify({ error: secret }),
            isRetryable: true,
          });
        },
      },
    );

    const error = await model.reviewClaims(evaluatorRequest()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InfrastructureFailureError);
    expect(error).toMatchObject({ code: "service_unavailable" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects a completed provider result that echoes the API key", async () => {
    const secret = "echoed-provider-secret";
    const model = new OpenAiCompatibleModelPort(
      liveConfig(secret),
      {
        streamText: () => ({
          stream: stream([
            { type: "text-delta", id: "text-1", text: secret },
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
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            },
          ]),
        }),
      },
    );

    await expect(model.generateResearchTurn(modelView())).rejects.toThrow(
      "OpenAI-compatible provider 未返回可提交的完整结果",
    );
  });
});

async function* stream(
  parts: readonly AiSdkStreamPart[],
): AsyncGenerator<AiSdkStreamPart> {
  for (const part of parts) yield part;
}

function modelView(): ModelView {
  return {
    runId: "run-1",
    question: "Run Journal 如何恢复？",
    fixedRules: ["只能使用批准的本地来源。"],
    approvedPlan: {
      title: "验证恢复边界",
      objectives: ["找到 canonical history 的原文"],
      steps: [{ id: "step-1", description: "搜索相关来源" }],
    },
    approvalBindingHash: "a".repeat(64),
    budgetVersion: "budget-v1",
    remainingBudget: {
      modelTurns: 3,
      toolCalls: 5,
      distinctSources: 2,
      sourceBytes: 10_000,
      wallTimeMs: 30_000,
    },
    evidenceGaps: [],
    evidenceGateRepairs: [],
    pendingIntents: [],
    relevantEvidence: [],
    recentObservations: [],
  };
}

function evaluatorRequest() {
  return {
    question: "Run Journal 如何恢复？",
    claims: [{
      claimId: "claim-1",
      kind: "source_fact" as const,
      text: "Run Journal 是 canonical history。",
      evidence: [{
        evidenceId: "evidence-1",
        sourceSnapshotId: `source-sha256:${"a".repeat(64)}`,
        relativePath: "source.md",
        startLine: 2,
        endLine: 2,
        excerpt: "Run Journal 是 canonical history。",
      }],
    }],
  };
}

function contractModel(
  streamText: OpenAiCompatibleModelDependencies["streamText"],
): OpenAiCompatibleModelPort {
  return new OpenAiCompatibleModelPort(
    {
      provider: "local-openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "contract-secret",
      model: "research-model",
      adapterVersion: "adapter-v1",
      promptVersion: "prompt-v1",
      toolSchemaVersion: "tools-v1",
    },
    { streamText },
  );
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
