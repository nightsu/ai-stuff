import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  RetryError,
  streamText,
} from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";

import {
  InfrastructureFailureError,
  ModelGenerationAbortedError,
} from "../application/ports.js";
import type {
  LearningArtifactProposalRequest,
  ModelCallOptions,
  ModelPort,
  PlanRequest,
} from "../application/ports.js";
import {
  parseLearningArtifactProposal,
  parseResearchPlan,
} from "../domain/schemas.js";
import type {
  ExperimentIdentity,
  LearningArtifactProposal,
  ModelTurn,
  ModelUsage,
  ModelView,
  ResearchPlan,
  ResearchToolIntent,
} from "../domain/types.js";

/** OpenAI-compatible Model Port 的非秘密配置与仅驻留内存的 credential。 */
export interface OpenAiCompatibleModelConfig extends ExperimentIdentity {
  /** OpenAI-compatible API 的 base URL；不会进入 Run Journal。 */
  readonly baseUrl: string;
  /** 仅交给 provider transport 的 bearer credential。 */
  readonly apiKey: string;
}

/** 读取 live provider 配置时使用的环境变量映射。 */
export interface OpenAiCompatibleModelEnvironment {
  /** provider 的逻辑名称。 */
  readonly EVIDENCE_MODEL_PROVIDER?: string | undefined;
  /** OpenAI-compatible API base URL。 */
  readonly EVIDENCE_MODEL_BASE_URL?: string | undefined;
  /** 只驻留在 provider transport 内存中的 API key。 */
  readonly EVIDENCE_MODEL_API_KEY?: string | undefined;
  /** provider 接收的模型标识。 */
  readonly EVIDENCE_MODEL_NAME?: string | undefined;
  /** 项目自有 adapter 行为版本。 */
  readonly EVIDENCE_MODEL_ADAPTER_VERSION?: string | undefined;
  /** prompt 模板版本。 */
  readonly EVIDENCE_MODEL_PROMPT_VERSION?: string | undefined;
  /** Research Tool schema 集合版本。 */
  readonly EVIDENCE_MODEL_TOOL_SCHEMA_VERSION?: string | undefined;
}

/** adapter 可消费的 AI SDK stream event 最小投影。 */
export interface AiSdkStreamPart {
  /** AI SDK stream event 判别字段。 */
  readonly type: string;
  /** text/tool-input delta 所属的 stream identity。 */
  readonly id?: string | undefined;
  /** text delta 的已完成字符串片段。 */
  readonly text?: string | undefined;
  /** tool-input JSON 文本片段。 */
  readonly delta?: string | undefined;
  /** completed tool call 的 provider call identity。 */
  readonly toolCallId?: string | undefined;
  /** completed tool call 或 input-start 的工具名。 */
  readonly toolName?: string | undefined;
  /** completed tool call 已解析的输入。 */
  readonly input?: unknown;
  /** provider-neutral generation 结束原因。 */
  readonly finishReason?: string | undefined;
  /** provider 原始结束原因；adapter 不持久化它。 */
  readonly rawFinishReason?: string | undefined;
  /** 完整 generation 的 AI SDK usage。 */
  readonly totalUsage?: AiSdkUsage | undefined;
  /** stream error event 的原始错误；只用于安全分类。 */
  readonly error?: unknown;
}

/** AI SDK usage 中 adapter 读取的 provider-neutral 字段。 */
export interface AiSdkUsage {
  /** prompt/context token 数。 */
  readonly inputTokens?: number | undefined;
  /** 生成结果 token 数。 */
  readonly outputTokens?: number | undefined;
  /** provider 报告的总 token 数。 */
  readonly totalTokens?: number | undefined;
  /** input token 的 cache 细分。 */
  readonly inputTokenDetails?: {
    /** 未命中 cache 的 input token 数；当前 adapter 不持久化。 */
    readonly noCacheTokens?: number | undefined;
    /** cache 命中的 input token 数。 */
    readonly cacheReadTokens?: number | undefined;
    /** 写入 provider cache 的 input token 数；当前 adapter 不持久化。 */
    readonly cacheWriteTokens?: number | undefined;
  } | undefined;
  /** output token 的 reasoning 细分。 */
  readonly outputTokenDetails?: {
    /** provider 标记为普通 text 的 output token 数；当前 adapter 不持久化。 */
    readonly textTokens?: number | undefined;
    /** provider 标记为 reasoning 的 output token 数。 */
    readonly reasoningTokens?: number | undefined;
  } | undefined;
}

/** 注入 `streamText` system boundary 所需的最小调用参数。 */
export interface AiSdkStreamTextOptions {
  /** createOpenAICompatible 返回的 language model。 */
  readonly model: unknown;
  /** 版本化、Harness-owned system instructions。 */
  readonly instructions: string;
  /** 当前一次 generation 的 provider request 文本。 */
  readonly prompt: string;
  /** 只声明 schema、绝不带 `execute` 的工具定义。 */
  readonly tools: Record<string, Record<string, unknown>>;
  /** 必须为 0，让 Harness 而不是 SDK 拥有 retry policy。 */
  readonly maxRetries: 0;
  /** 调用方提供的取消信号。 */
  readonly abortSignal?: AbortSignal | undefined;
  /** 强制结构化 generation 返回一个 tool call。 */
  readonly toolChoice: "required";
}

/** 注入的 AI SDK streamText 返回值最小投影。 */
export interface AiSdkStreamTextResult {
  /** 包含 text/tool-input/tool-call/finish/error 的完整事件流。 */
  readonly stream: AsyncIterable<AiSdkStreamPart>;
}

/** tests 可替换的唯一 provider SDK system boundary。 */
export interface OpenAiCompatibleModelDependencies {
  /** 启动一次单步 AI SDK Core streaming generation。 */
  readonly streamText: (
    options: AiSdkStreamTextOptions,
  ) => AiSdkStreamTextResult;
  /** 解析 HTTP-date `Retry-After` 时使用的可注入 Unix epoch 毫秒时钟。 */
  readonly nowMs?: (() => number) | undefined;
}

/** provider 配置缺失或无效时抛出的 payload-safe 错误。 */
export class OpenAiCompatibleModelConfigurationError extends Error {
  public constructor() {
    super("OpenAI-compatible Model Port 配置无效");
    this.name = "OpenAiCompatibleModelConfigurationError";
  }
}

/** provider 返回不可提交 generation 时抛出的 payload-safe 永久错误。 */
export class OpenAiCompatibleModelResponseError extends Error {
  public constructor() {
    super("OpenAI-compatible provider 未返回可提交的完整结果");
    this.name = "OpenAiCompatibleModelResponseError";
  }
}

const DEFAULT_ADAPTER_VERSION = "openai-compatible-adapter-v1";
const DEFAULT_PROMPT_VERSION = "evidence-research-prompts-v1";
const DEFAULT_TOOL_SCHEMA_VERSION = "research-tools-v1";
const evidenceGapsSchema = z.array(z.string().trim().min(1)).default([]);
const researchToolSchemas = {
  search_sources: z.object({
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().positive().max(50),
    evidenceGaps: evidenceGapsSchema,
  }).strict(),
  read_source: z.object({
    rootIndex: z.number().int().nonnegative(),
    relativePath: z.string().trim().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    evidenceGaps: evidenceGapsSchema,
  }).strict(),
  record_evidence: z.object({
    observationId: z.string().trim().min(1),
    evidenceGaps: evidenceGapsSchema,
  }).strict(),
  propose_claim: z.object({
    kind: z.literal("source_fact"),
    text: z.string().trim().min(1),
    evidenceIds: z.array(z.string().trim().min(1)).min(1),
    evidenceGaps: evidenceGapsSchema,
  }).strict(),
  complete_research: z.object({
    unresolvedQuestions: z.array(z.string().trim().min(1)),
    evidenceGaps: evidenceGapsSchema,
  }).strict(),
} as const;

const researchTools = Object.fromEntries(
  Object.entries(researchToolSchemas).map(([name, inputSchema]) => [
    name,
    {
      description: researchToolDescription(name),
      inputSchema,
    },
  ]),
);

const planTool = {
  submit_research_plan: {
    description: "提交完整、等待用户审批的研究计划。",
    inputSchema: z.object({
      title: z.string().trim().min(1),
      objectives: z.array(z.string().trim().min(1)).min(1),
      steps: z.array(z.object({
        id: z.string().trim().min(1),
        description: z.string().trim().min(1),
      }).strict()).min(1),
    }).strict(),
  },
};

const artifactTool = {
  submit_learning_artifact: {
    description: "从请求中已有的 Claim identities 选择并组织 Learning Artifact。",
    inputSchema: z.object({
      title: z.string().trim().min(1),
      summary: z.string().trim().min(1),
      claimIds: z.array(z.string().trim().min(1)).min(1),
    }).strict(),
  },
};

/** 用 AI SDK Core 单步 streaming 隔离 OpenAI-compatible provider 的 Model Port。 */
export class OpenAiCompatibleModelPort implements ModelPort {
  /** 可持久化且明确排除 API key/base URL 的实验身份。 */
  public readonly experimentIdentity: ExperimentIdentity;
  /** provider factory 创建的 language model；credential 只封装在其 transport closure。 */
  readonly #model: unknown;
  /** 用于拒绝 provider 意外回显 credential 的内存内 secret。 */
  readonly #apiKey: string;
  /** 唯一可替换的外部 SDK streaming boundary。 */
  readonly #dependencies: OpenAiCompatibleModelDependencies;

  public constructor(
    config: OpenAiCompatibleModelConfig,
    dependencies: OpenAiCompatibleModelDependencies = productionDependencies,
  ) {
    const parsed = parseConfig(config);
    this.experimentIdentity = Object.freeze({
      provider: parsed.provider,
      model: parsed.model,
      adapterVersion: parsed.adapterVersion,
      promptVersion: parsed.promptVersion,
      toolSchemaVersion: parsed.toolSchemaVersion,
    });
    this.#model = createOpenAICompatible({
      name: parsed.provider,
      baseURL: parsed.baseUrl,
      apiKey: parsed.apiKey,
      includeUsage: true,
    })(parsed.model);
    this.#apiKey = parsed.apiKey;
    this.#dependencies = dependencies;
  }

  public async proposePlan(
    request: PlanRequest,
    options: ModelCallOptions = {},
  ): Promise<ResearchPlan> {
    const call = await this.#completeToolCall(
      "submit_research_plan",
      planTool,
      JSON.stringify(request),
      options,
    );
    assertSecretAbsent(call.input, this.#apiKey);
    return parseResearchPlan(call.input);
  }

  public async proposeLearningArtifact(
    request: LearningArtifactProposalRequest,
    options: ModelCallOptions = {},
  ): Promise<LearningArtifactProposal> {
    const call = await this.#completeToolCall(
      "submit_learning_artifact",
      artifactTool,
      JSON.stringify(request),
      options,
    );
    assertSecretAbsent(call.input, this.#apiKey);
    return parseLearningArtifactProposal(call.input);
  }

  public async generateResearchTurn(
    view: ModelView,
    options: ModelCallOptions = {},
  ): Promise<Omit<ModelTurn, "turnId" | "completedAt">> {
    const completed = await this.#consume(
      researchTools,
      JSON.stringify(view),
      options,
    );
    if (completed.finishReason !== "tool-calls" || completed.calls.length === 0) {
      throw new OpenAiCompatibleModelResponseError();
    }
    assertSecretAbsent(completed, this.#apiKey);
    const normalized = completed.calls.map(normalizeResearchToolCall);
    return {
      text: completed.text,
      evidenceGaps: unique(normalized.flatMap((call) => call.evidenceGaps)),
      finishReason: "tool_calls",
      toolIntents: normalized.map((call) => call.intent),
      usage: completed.usage,
    };
  }

  async #completeToolCall(
    expectedToolName: string,
    tools: Record<string, Record<string, unknown>>,
    prompt: string,
    options: ModelCallOptions,
  ): Promise<CompletedToolCall> {
    const completed = await this.#consume(tools, prompt, options);
    const call = completed.calls[0];
    if (
      completed.finishReason !== "tool-calls" ||
      completed.calls.length !== 1 ||
      call?.toolName !== expectedToolName
    ) {
      throw new OpenAiCompatibleModelResponseError();
    }
    return call;
  }

  async #consume(
    tools: Record<string, Record<string, unknown>>,
    prompt: string,
    options: ModelCallOptions,
  ): Promise<CompletedGeneration> {
    const textParts: string[] = [];
    const argumentDeltas = new Map<string, string>();
    const calls: CompletedToolCall[] = [];
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;
    try {
      const result = this.#dependencies.streamText({
        model: this.#model,
        instructions: instructions(this.experimentIdentity),
        prompt,
        tools,
        maxRetries: 0,
        ...(options.abortSignal === undefined
          ? {}
          : { abortSignal: options.abortSignal }),
        toolChoice: "required",
      });
      for await (const part of result.stream) {
        if (part.type === "text-delta" && part.text !== undefined) {
          textParts.push(part.text);
        } else if (
          part.type === "tool-input-start" &&
          part.id !== undefined
        ) {
          argumentDeltas.set(part.id, "");
        } else if (
          part.type === "tool-input-delta" &&
          part.id !== undefined &&
          part.delta !== undefined
        ) {
          argumentDeltas.set(
            part.id,
            `${argumentDeltas.get(part.id) ?? ""}${part.delta}`,
          );
        } else if (part.type === "tool-call") {
          calls.push(completedToolCall(part, argumentDeltas));
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = normalizeUsage(part.totalUsage);
        } else if (part.type === "abort") {
          throw new ModelGenerationAbortedError();
        } else if (part.type === "error") {
          throw part.error;
        }
      }
    } catch (error) {
      throw normalizeProviderError(
        error,
        options.abortSignal,
        this.#dependencies.nowMs ?? Date.now,
      );
    }
    // 只有观察到 SDK 的 terminal finish event 后才返回；此前所有 delta 只存在
    // 于本地临时变量，网络中断、取消或解析失败都不可能伪装成 canonical turn。
    if (finishReason === undefined || usage === undefined) {
      throw new OpenAiCompatibleModelResponseError();
    }
    return { text: textParts.join(""), calls, finishReason, usage };
  }
}

/** 从环境变量创建 live OpenAI-compatible Model Port。 */
export function createOpenAiCompatibleModelPortFromEnv(
  environment: OpenAiCompatibleModelEnvironment = process.env,
): OpenAiCompatibleModelPort {
  return new OpenAiCompatibleModelPort({
    provider: requiredEnvironmentValue(environment.EVIDENCE_MODEL_PROVIDER),
    baseUrl: requiredEnvironmentValue(environment.EVIDENCE_MODEL_BASE_URL),
    apiKey: requiredEnvironmentValue(environment.EVIDENCE_MODEL_API_KEY),
    model: requiredEnvironmentValue(environment.EVIDENCE_MODEL_NAME),
    adapterVersion: optionalEnvironmentValue(
      environment.EVIDENCE_MODEL_ADAPTER_VERSION,
      DEFAULT_ADAPTER_VERSION,
    ),
    promptVersion: optionalEnvironmentValue(
      environment.EVIDENCE_MODEL_PROMPT_VERSION,
      DEFAULT_PROMPT_VERSION,
    ),
    toolSchemaVersion: optionalEnvironmentValue(
      environment.EVIDENCE_MODEL_TOOL_SCHEMA_VERSION,
      DEFAULT_TOOL_SCHEMA_VERSION,
    ),
  });
}

interface CompletedToolCall {
  /** provider call identity，成为 Model Turn 内稳定 intent identity。 */
  readonly toolCallId: string;
  /** 已匹配 schema-only definition 的工具名。 */
  readonly toolName: string;
  /** 完整 JSON 参数；stream 中断时永远不会返回。 */
  readonly input: unknown;
}

interface CompletedGeneration {
  /** 按到达顺序拼装的全部 text delta。 */
  readonly text: string;
  /** 按 completed tool-call event 顺序保存的调用。 */
  readonly calls: readonly CompletedToolCall[];
  /** AI SDK 的 provider-neutral terminal finish reason。 */
  readonly finishReason: string;
  /** 去除 provider raw payload 后的 token usage。 */
  readonly usage: ModelUsage;
}

interface NormalizedResearchCall {
  /** 可直接交给 Harness schema 再验证的 provider-neutral intent。 */
  readonly intent: ResearchToolIntent;
  /** 本工具调用后模型声明仍未关闭的 evidence gaps。 */
  readonly evidenceGaps: readonly string[];
}

const productionDependencies: OpenAiCompatibleModelDependencies = {
  streamText: (options) => {
    const result = streamText({
      model: options.model as LanguageModel,
      instructions: options.instructions,
      prompt: options.prompt,
      tools: options.tools as ToolSet,
      maxRetries: options.maxRetries,
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
      toolChoice: options.toolChoice,
    });
    return { stream: result.stream as AsyncIterable<AiSdkStreamPart> };
  },
  nowMs: Date.now,
};

function parseConfig(config: OpenAiCompatibleModelConfig): OpenAiCompatibleModelConfig {
  const parsed = z.object({
    provider: z.string().trim().min(1),
    baseUrl: z.url(),
    apiKey: z.string().trim().min(1),
    model: z.string().trim().min(1),
    adapterVersion: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    toolSchemaVersion: z.string().trim().min(1),
  }).strict().safeParse(config);
  if (!parsed.success) throw new OpenAiCompatibleModelConfigurationError();
  return parsed.data;
}

function completedToolCall(
  part: AiSdkStreamPart,
  argumentDeltas: ReadonlyMap<string, string>,
): CompletedToolCall {
  if (part.toolCallId === undefined || part.toolName === undefined) {
    throw new OpenAiCompatibleModelResponseError();
  }
  const raw = argumentDeltas.get(part.toolCallId);
  let input = part.input;
  if (raw !== undefined && raw !== "") {
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      throw new OpenAiCompatibleModelResponseError();
    }
  }
  return { toolCallId: part.toolCallId, toolName: part.toolName, input };
}

function normalizeResearchToolCall(
  call: CompletedToolCall,
): NormalizedResearchCall {
  if (!(call.toolName in researchToolSchemas)) {
    throw new OpenAiCompatibleModelResponseError();
  }
  const name = call.toolName as keyof typeof researchToolSchemas;
  const parsed = researchToolSchemas[name].safeParse(call.input);
  if (!parsed.success) throw new OpenAiCompatibleModelResponseError();
  const { evidenceGaps, ...input } = parsed.data;
  return {
    intent: { intentId: call.toolCallId, name, input },
    evidenceGaps,
  } as NormalizedResearchCall;
}

function normalizeUsage(usage: AiSdkUsage | undefined): ModelUsage {
  if (usage === undefined) throw new OpenAiCompatibleModelResponseError();
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.inputTokenDetails?.cacheReadTokens === undefined
      ? {}
      : { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.outputTokenDetails?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
  };
}

function normalizeProviderError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  nowMs: () => number,
): Error {
  if (
    error instanceof ModelGenerationAbortedError ||
    abortSignal?.aborted === true ||
    isAbortError(error) ||
    (RetryError.isInstance(error) && error.reason === "abort")
  ) {
    return new ModelGenerationAbortedError();
  }
  const providerError = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(providerError)) {
    const retryAfterMs = parseRetryAfterMs(providerError.responseHeaders, nowMs);
    if (providerError.statusCode === 429) {
      return new InfrastructureFailureError("rate_limited", { retryAfterMs });
    }
    if (providerError.statusCode === 408 || providerError.statusCode === 504) {
      return new InfrastructureFailureError("request_timeout", { retryAfterMs });
    }
    if (
      providerError.statusCode !== undefined &&
      providerError.statusCode >= 500 &&
      providerError.statusCode <= 599
    ) {
      return new InfrastructureFailureError("service_unavailable", { retryAfterMs });
    }
    if (providerError.statusCode === undefined && providerError.isRetryable) {
      return new InfrastructureFailureError("connection_failed", { retryAfterMs });
    }
  }
  return new OpenAiCompatibleModelResponseError();
}

function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  nowMs: () => number,
): number | undefined {
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - nowMs());
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function instructions(identity: ExperimentIdentity): string {
  return [
    `Prompt version: ${identity.promptVersion}`,
    `Tool schema version: ${identity.toolSchemaVersion}`,
    "只进行一次 generation；选择一个或多个 schema 工具表达下一步，不执行工具。",
    "每个工具调用都填写 evidenceGaps；不要输出 credential、环境变量或 provider payload。",
  ].join("\n");
}

function researchToolDescription(name: string): string {
  return `提出 ${name} intent；Harness 将在完整 Model Turn 提交后验证并调度。`;
}

function requiredEnvironmentValue(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new OpenAiCompatibleModelConfigurationError();
  }
  return value.trim();
}

function optionalEnvironmentValue(
  value: string | undefined,
  fallback: string,
): string {
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertSecretAbsent(value: unknown, apiKey: string): void {
  // Provider 可能错误地把 request metadata 或 credential 回显到模型内容；宁可
  // 丢弃整个 completed result，也不能让该字符串进入 plan/draft Artifact 或 Turn。
  if (JSON.stringify(value).includes(apiKey)) {
    throw new OpenAiCompatibleModelResponseError();
  }
}
