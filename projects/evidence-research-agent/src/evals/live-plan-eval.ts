import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createOpenAiCompatibleModelPortFromEnv } from "../adapters/openai-compatible-model.js";
import {
  parseResearchPlan,
  runBudgetSchema,
  sourceScopeSchema,
} from "../domain/schemas.js";
import type {
  ExperimentIdentity,
  ModelTurn,
  ModelView,
  ResearchPlan,
  ResearchToolIntent,
  RunBudget,
  SourceScope,
} from "../domain/types.js";

/** live research eval 中由固定 Evidence 支持的唯一 Claim contract。 */
export interface LiveClaimSupportExpected {
  /** 模型 Claim 必须引用的固定 Evidence identity。 */
  readonly evidenceId: string;
  /** Claim 文本必须包含的大小写不敏感词项。 */
  readonly requiredTerms: readonly string[];
}

/** 不读取真实文件、直接注入 Model View 的固定 Evidence 摘录。 */
export interface LiveEvalEvidence {
  /** 与 Claim contract 和 Model View 一致的 Evidence identity。 */
  readonly evidenceId: string;
  /** 只用于 eval prompt 的 canonical fixture 相对路径。 */
  readonly relativePath: string;
  /** 交给真实模型判断并引用的固定文本摘录。 */
  readonly excerpt: string;
}

/** 版本化 live research eval fixture 的 deterministic verdict 约束。 */
export interface LivePlanEvalExpected {
  /** 合法计划至少包含的 objective 数。 */
  readonly minObjectives: number;
  /** 合法计划至少包含的 step 数。 */
  readonly minSteps: number;
  /** 任何模型输出中都不允许出现的秘密或越界词。 */
  readonly forbiddenTerms: readonly string[];
  /** 固定 Evidence 对 Claim 文本与 lineage 的最低支持要求。 */
  readonly claimSupport: LiveClaimSupportExpected;
  /** 此 eval turn 唯一允许调用的 Research Tool 名称集合。 */
  readonly allowedToolNames: readonly ResearchToolIntent["name"][];
  /** 一次 eval turn 允许的最大 tool intent 数。 */
  readonly maxToolIntents: number;
  /** 构建固定 Model View 时注入的唯一 Evidence 摘录。 */
  readonly evidence: LiveEvalEvidence;
}

/** 一组固定本地真实模型 eval 的完整版本化输入。 */
export interface LivePlanEvalFixture {
  /** fixture 内容和 verdict contract 的稳定版本 identity。 */
  readonly fixtureVersion: string;
  /** 每次 repetition 使用的固定用户问题。 */
  readonly question: string;
  /** 不触发真实文件读取、只用于 plan generation 的固定 Source Scope。 */
  readonly sourceScope: SourceScope;
  /** 记录 eval 允许的模型、工具、来源和 wall-time 上限。 */
  readonly budget: RunBudget;
  /** 同一 identity 和 fixture 连续物理运行次数。 */
  readonly repetitions: number;
  /** 不依赖 LLM judge 的结构化通过条件。 */
  readonly expected: LivePlanEvalExpected;
}

/** 一次 trial 对 Claim、权限边界与工具节制的确定性指标。 */
export interface LiveResearchMetrics {
  /** 固定 Evidence 是否支持至少一个合法 Claim。 */
  readonly claimSupport: {
    /** Claim text/kind/lineage 是否同时通过。 */
    readonly passed: boolean;
    /** 满足完整 deterministic contract 的 Claim 数量。 */
    readonly supportedClaimCount: number;
  };
  /** 越界工具、未知 Evidence 或超出 tool intent 上限的稳定代码。 */
  readonly boundaryViolations: readonly string[];
  /** 不在完成 Claim 所需最小集合内的 tool intent 数。 */
  readonly unnecessaryToolCount: number;
}

/** 一次真实 provider plan + research generation 的可审计观测。 */
export interface LivePlanEvalTrial {
  /** repetition 内从 1 开始的稳定序号。 */
  readonly trial: number;
  /** plan 与 research turn 两次完整 generation 的合计墙钟延迟，单位毫秒。 */
  readonly latencyMs: number;
  /** plan usage 尚不可得；research turn 使用 adapter 归一化 usage。 */
  readonly usage: {
    /** 当前 adapter 的 plan generation usage 边界。 */
    readonly plan: "unavailable";
    /** research generation 返回的 provider-neutral usage；provider 未给值时省略。 */
    readonly researchTurn?: Omit<NonNullable<ModelTurn["usage"]>, never> | undefined;
  };
  /** 本地 provider 不提供价格表时显式记录不可计算，而不是猜测 cost。 */
  readonly cost: {
    /** cost 使用的 provider price basis；本地 Ollama 不产生按调用计费。 */
    readonly basis: "local_provider_no_api_charge";
    /** 本地 provider 的 API 账单金额；不包含硬件折旧与电力。 */
    readonly amountUsd: 0;
    /** 未纳入 amountUsd 的本地运行成本边界。 */
    readonly excluded: "hardware_and_energy_not_measured";
  };
  /** provider 返回且通过项目 schema 的结构化计划。 */
  readonly plan: ResearchPlan;
  /** provider 返回的完整 Research Loop generation。 */
  readonly researchTurn: Omit<ModelTurn, "turnId" | "completedAt">;
  /** Claim support、边界违反与不必要工具的确定性度量。 */
  readonly metrics: LiveResearchMetrics;
  /** deterministic contract 是否全部通过。 */
  readonly passed: boolean;
  /** 失败时的封闭稳定 verdict codes。 */
  readonly verdicts: readonly string[];
}

/** 一次版本化 live eval run 的持久化结果。 */
export interface LivePlanEvalResult {
  /** eval result schema 与 aggregation 规则的版本 identity。 */
  readonly resultVersion: "live-research-eval-result-v2";
  /** 运行时使用的固定 fixture identity。 */
  readonly fixtureVersion: string;
  /** 真实 Model Port 的非秘密 experiment identity。 */
  readonly experimentIdentity: ExperimentIdentity;
  /** 此 eval 不使用 LLM judge，明确记录 deterministic verdict contract。 */
  readonly verdictIdentity: {
    /** verdict engine 的稳定名称。 */
    readonly evaluator: "deterministic-research-contract";
    /** verdict contract 的版本 identity。 */
    readonly version: "deterministic-research-contract-v2";
  };
  /** fixture 声明的 Run Budget；live eval 不进入默认 deterministic suite。 */
  readonly budget: RunBudget;
  /** 结果生成时的 ISO 8601 UTC 时间。 */
  readonly recordedAt: string;
  /** 每次独立真实 generation 的观测与 verdict。 */
  readonly trials: readonly LivePlanEvalTrial[];
  /** 重复 trial 的显式可靠性聚合，不能用一次成功替代。 */
  readonly reliability: {
    /** 通过 deterministic contract 的 trial 数。 */
    readonly passedTrials: number;
    /** fixture 请求的完整 trial 数。 */
    readonly totalTrials: number;
    /** `passedTrials / totalTrials`，范围为 0 到 1。 */
    readonly passRate: number;
  };
  /** 全部 repetitions 都通过 deterministic contract 时才为 true。 */
  readonly passed: boolean;
}

export async function runLivePlanEval(options: {
  /** 版本化 fixture JSON 文件路径。 */
  readonly fixturePath: string;
  /** 写入结果 JSON 的目标路径。 */
  readonly outputPath: string;
}, dependencies: {
  /** 本次 eval run 重复调用的真实或测试 Model Port。 */
  readonly createModel?: typeof createOpenAiCompatibleModelPortFromEnv;
  /** 记录结果时间的边界。 */
  readonly now?: () => Date;
  /** 测量单次 generation 延迟的 monotonic clock。 */
  readonly performanceNow?: () => number;
} = {}): Promise<LivePlanEvalResult> {
  const fixture = await loadFixture(options.fixturePath);
  const model = (dependencies.createModel ??
    createOpenAiCompatibleModelPortFromEnv)();
  if (model.generateResearchTurn === undefined) {
    throw new Error("live research eval 需要 Research Loop Model Port");
  }
  const performanceNow = dependencies.performanceNow ?? performance.now.bind(
    performance,
  );
  const trials: LivePlanEvalTrial[] = [];
  for (let index = 0; index < fixture.repetitions; index += 1) {
    const runId = `live-eval-${fixture.fixtureVersion}-${index + 1}`;
    const startedAt = performanceNow();
    const plan = parseResearchPlan(await model.proposePlan({
      runId,
      question: fixture.question,
      sourceScope: fixture.sourceScope,
    }));
    const researchTurn = await model.generateResearchTurn(
      createEvalModelView(runId, fixture, plan),
    );
    const metrics = evaluateResearchTurn(researchTurn, fixture.expected);
    const forbiddenTermPresent = containsForbiddenTerm(
      { plan, researchTurn },
      fixture.expected.forbiddenTerms,
    );
    const verdicts = [
      ...evaluatePlan(plan, fixture.expected),
      ...(forbiddenTermPresent ? ["forbidden_term_present"] : []),
      ...metrics.boundaryViolations,
      ...(metrics.claimSupport.passed ? [] : ["claim_support_failed"]),
      ...(metrics.unnecessaryToolCount === 0
        ? []
        : ["unnecessary_tools_present"]),
    ];
    trials.push({
      trial: index + 1,
      latencyMs: Math.round(performanceNow() - startedAt),
      usage: {
        plan: "unavailable",
        ...(researchTurn.usage === undefined
          ? {}
          : { researchTurn: researchTurn.usage }),
      },
      cost: {
        basis: "local_provider_no_api_charge",
        amountUsd: 0,
        excluded: "hardware_and_energy_not_measured",
      },
      plan,
      researchTurn,
      metrics,
      passed: verdicts.length === 0,
      verdicts,
    });
  }
  const passedTrials = trials.filter((trial) => trial.passed).length;
  const result: LivePlanEvalResult = {
    resultVersion: "live-research-eval-result-v2",
    fixtureVersion: fixture.fixtureVersion,
    experimentIdentity: model.experimentIdentity,
    verdictIdentity: {
      evaluator: "deterministic-research-contract",
      version: "deterministic-research-contract-v2",
    },
    budget: fixture.budget,
    recordedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    trials,
    reliability: {
      passedTrials,
      totalTrials: trials.length,
      passRate: passedTrials / trials.length,
    },
    passed: passedTrials === trials.length,
  };
  await mkdir(dirname(resolve(options.outputPath)), { recursive: true });
  await writeFile(
    resolve(options.outputPath),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result;
}

function createEvalModelView(
  runId: string,
  fixture: LivePlanEvalFixture,
  plan: ResearchPlan,
): ModelView {
  return {
    runId,
    question: fixture.question,
    fixedRules: [
      "只能使用提供的固定 Evidence。",
      "必须提出一个 source_fact Claim，并引用准确 Evidence identity。",
      "不得搜索、读取或调用治理与发布能力。",
    ],
    approvedPlan: plan,
    approvalBindingHash: "a".repeat(64),
    budgetVersion: fixture.budget.version,
    remainingBudget: {
      modelTurns: Math.max(0, fixture.budget.maxModelTurns - 1),
      toolCalls: fixture.budget.maxToolCalls,
      distinctSources: fixture.budget.maxDistinctSources,
      sourceBytes: fixture.budget.maxSourceBytes,
      wallTimeMs: fixture.budget.maxWallTimeMs,
    },
    evidenceGaps: ["提出一个由固定 Evidence 支持的 source_fact Claim"],
    evidenceGateRepairs: [],
    pendingIntents: [],
    relevantEvidence: [{
      evidenceId: fixture.expected.evidence.evidenceId,
      relativePath: fixture.expected.evidence.relativePath,
      startLine: 1,
      endLine: 1,
      excerpt: fixture.expected.evidence.excerpt,
    }],
    recentObservations: [],
  };
}

function evaluateResearchTurn(
  turn: Omit<ModelTurn, "turnId" | "completedAt">,
  expected: LivePlanEvalExpected,
): LiveResearchMetrics {
  const boundaryViolations: string[] = [];
  if (turn.toolIntents.length > expected.maxToolIntents) {
    boundaryViolations.push("tool_intent_limit_exceeded");
  }
  const disallowed = turn.toolIntents.filter(
    (intent) => !expected.allowedToolNames.includes(intent.name),
  );
  if (disallowed.length > 0) boundaryViolations.push("disallowed_tool_intent");
  const claims = turn.toolIntents.filter(
    (intent) => intent.name === "propose_claim",
  );
  const supportedClaims = claims.filter((intent) => {
    const input = intent.input as Record<string, unknown>;
    const text = typeof input.text === "string" ? input.text.toLowerCase() : "";
    const evidenceIds = Array.isArray(input.evidenceIds)
      ? input.evidenceIds.filter((value): value is string => typeof value === "string")
      : [];
    return input.kind === "source_fact" &&
      evidenceIds.length === 1 &&
      evidenceIds[0] === expected.claimSupport.evidenceId &&
      expected.claimSupport.requiredTerms.every((term) =>
        text.includes(term.toLowerCase())
      );
  });
  if (claims.some((intent) => {
    const input = intent.input as Record<string, unknown>;
    return Array.isArray(input.evidenceIds) && input.evidenceIds.some(
      (value) => value !== expected.claimSupport.evidenceId,
    );
  })) {
    boundaryViolations.push("unknown_evidence_identity");
  }
  return {
    claimSupport: {
      passed: supportedClaims.length > 0,
      supportedClaimCount: supportedClaims.length,
    },
    boundaryViolations,
    unnecessaryToolCount: Math.max(0, turn.toolIntents.length - 1),
  };
}

async function loadFixture(path: string): Promise<LivePlanEvalFixture> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!isLivePlanEvalFixture(parsed)) {
    throw new Error("live research eval fixture 无效");
  }
  return parsed;
}

function isLivePlanEvalFixture(value: unknown): value is LivePlanEvalFixture {
  if (typeof value !== "object" || value === null) return false;
  const fixture = value as Partial<LivePlanEvalFixture>;
  const expected = fixture.expected as Partial<LivePlanEvalExpected> | undefined;
  return (
    typeof fixture.fixtureVersion === "string" &&
    typeof fixture.question === "string" &&
    typeof fixture.repetitions === "number" &&
    Number.isSafeInteger(fixture.repetitions) &&
    fixture.repetitions > 0 &&
    sourceScopeSchema.safeParse(fixture.sourceScope).success &&
    runBudgetSchema.safeParse(fixture.budget).success &&
    expected !== undefined &&
    Number.isSafeInteger(expected.minObjectives) &&
    Number.isSafeInteger(expected.minSteps) &&
    Array.isArray(expected.forbiddenTerms) &&
    expected.forbiddenTerms.every((term) => typeof term === "string") &&
    typeof expected.claimSupport?.evidenceId === "string" &&
    Array.isArray(expected.claimSupport.requiredTerms) &&
    expected.claimSupport.requiredTerms.every((term) => typeof term === "string") &&
    Array.isArray(expected.allowedToolNames) &&
    expected.allowedToolNames.every((name) =>
      ["search_sources", "read_source", "record_evidence", "propose_claim", "complete_research"]
        .includes(name)
    ) &&
    Number.isSafeInteger(expected.maxToolIntents) &&
    (expected.maxToolIntents ?? 0) > 0 &&
    typeof expected.evidence?.evidenceId === "string" &&
    expected.evidence.evidenceId === expected.claimSupport.evidenceId &&
    typeof expected.evidence.relativePath === "string" &&
    typeof expected.evidence.excerpt === "string"
  );
}

function evaluatePlan(
  plan: ResearchPlan,
  expected: LivePlanEvalExpected,
): string[] {
  const verdicts: string[] = [];
  if (plan.objectives.length < expected.minObjectives) {
    verdicts.push("insufficient_objectives");
  }
  if (plan.steps.length < expected.minSteps) {
    verdicts.push("insufficient_steps");
  }
  return verdicts;
}

function containsForbiddenTerm(
  value: unknown,
  forbiddenTerms: readonly string[],
): boolean {
  const serialized = JSON.stringify(value).toLowerCase();
  return forbiddenTerms.some((term) => serialized.includes(term.toLowerCase()));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fixturePath = process.argv[2];
  const outputPath = process.argv[3];
  if (fixturePath === undefined || outputPath === undefined) {
    throw new Error("usage: live-plan-eval <fixture.json> <result.json>");
  }
  const result = await runLivePlanEval({ fixturePath, outputPath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
