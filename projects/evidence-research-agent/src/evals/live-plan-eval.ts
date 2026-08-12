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
  ResearchPlan,
  RunBudget,
  SourceScope,
} from "../domain/types.js";

/** 版本化 live plan eval fixture 的 deterministic verdict 约束。 */
export interface LivePlanEvalExpected {
  /** 合法计划至少包含的 objective 数。 */
  readonly minObjectives: number;
  /** 合法计划至少包含的 step 数。 */
  readonly minSteps: number;
  /** 任何模型输出中都不允许出现的秘密或越界词。 */
  readonly forbiddenTerms: readonly string[];
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

/** 一次真实 provider generation 的可审计观测。 */
export interface LivePlanEvalTrial {
  /** repetition 内从 1 开始的稳定序号。 */
  readonly trial: number;
  /** 完整 generation 的墙钟延迟，单位毫秒。 */
  readonly latencyMs: number;
  /** 当前 adapter 未暴露 plan usage，因此显式记录 unavailable。 */
  readonly usage: "unavailable";
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
  /** deterministic contract 是否全部通过。 */
  readonly passed: boolean;
  /** 失败时的封闭稳定 verdict codes。 */
  readonly verdicts: readonly string[];
}

/** 一次版本化 live eval run 的持久化结果。 */
export interface LivePlanEvalResult {
  /** eval result schema 与 aggregation 规则的版本 identity。 */
  readonly resultVersion: "live-plan-eval-result-v1";
  /** 运行时使用的固定 fixture identity。 */
  readonly fixtureVersion: string;
  /** 真实 Model Port 的非秘密 experiment identity。 */
  readonly experimentIdentity: ExperimentIdentity;
  /** Evaluator identity；此 eval 不使用 LLM judge，明确记录为 deterministic。 */
  readonly verdictIdentity: {
    /** verdict engine 的稳定名称。 */
    readonly evaluator: "deterministic-plan-contract";
    /** verdict contract 的版本 identity。 */
    readonly version: "deterministic-plan-contract-v1";
  };
  /** fixture 声明的 Run Budget；live eval 不进入默认 deterministic suite。 */
  readonly budget: RunBudget;
  /** 结果生成时的 ISO 8601 UTC 时间。 */
  readonly recordedAt: string;
  /** 每次独立真实 generation 的观测与 verdict。 */
  readonly trials: readonly LivePlanEvalTrial[];
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
  const performanceNow = dependencies.performanceNow ?? performance.now.bind(
    performance,
  );
  const trials: LivePlanEvalTrial[] = [];
  for (let index = 0; index < fixture.repetitions; index += 1) {
    const startedAt = performanceNow();
    const plan = parseResearchPlan(await model.proposePlan({
      runId: `live-eval-${fixture.fixtureVersion}-${index + 1}`,
      question: fixture.question,
      sourceScope: fixture.sourceScope,
    }));
    const verdicts = evaluatePlan(plan, fixture.expected);
    trials.push({
      trial: index + 1,
      latencyMs: Math.round(performanceNow() - startedAt),
      usage: "unavailable",
      cost: {
        basis: "local_provider_no_api_charge",
        amountUsd: 0,
        excluded: "hardware_and_energy_not_measured",
      },
      plan,
      passed: verdicts.length === 0,
      verdicts,
    });
  }
  const result: LivePlanEvalResult = {
    resultVersion: "live-plan-eval-result-v1",
    fixtureVersion: fixture.fixtureVersion,
    experimentIdentity: model.experimentIdentity,
    verdictIdentity: {
      evaluator: "deterministic-plan-contract",
      version: "deterministic-plan-contract-v1",
    },
    budget: fixture.budget,
    recordedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    trials,
    passed: trials.every((trial) => trial.passed),
  };
  await mkdir(dirname(resolve(options.outputPath)), { recursive: true });
  await writeFile(
    resolve(options.outputPath),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result;
}

async function loadFixture(path: string): Promise<LivePlanEvalFixture> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!isLivePlanEvalFixture(parsed)) {
    throw new Error("live plan eval fixture 无效");
  }
  return parsed;
}

function isLivePlanEvalFixture(value: unknown): value is LivePlanEvalFixture {
  if (typeof value !== "object" || value === null) return false;
  const fixture = value as Partial<LivePlanEvalFixture>;
  return (
    typeof fixture.fixtureVersion === "string" &&
    typeof fixture.question === "string" &&
    typeof fixture.repetitions === "number" &&
    Number.isSafeInteger(fixture.repetitions) &&
    fixture.repetitions > 0 &&
    sourceScopeSchema.safeParse(fixture.sourceScope).success &&
    runBudgetSchema.safeParse(fixture.budget).success &&
    typeof fixture.expected === "object" &&
    fixture.expected !== null &&
    Number.isSafeInteger(fixture.expected.minObjectives) &&
    fixture.expected.minObjectives >= 0 &&
    Number.isSafeInteger(fixture.expected.minSteps) &&
    fixture.expected.minSteps >= 0 &&
    Array.isArray(fixture.expected.forbiddenTerms) &&
    fixture.expected.forbiddenTerms.every((term) => typeof term === "string")
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
  const serialized = JSON.stringify(plan);
  if (expected.forbiddenTerms.some((term) => serialized.includes(term))) {
    verdicts.push("forbidden_term_present");
  }
  return verdicts;
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
