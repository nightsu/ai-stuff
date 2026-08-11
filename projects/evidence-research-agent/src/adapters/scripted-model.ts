import { parseResearchPlan } from "../domain/schemas.js";
import type { ResearchPlan } from "../domain/types.js";
import type { ModelPort, PlanRequest } from "../application/ports.js";

/** 当测试脚本没有剩余模型输出时抛出的确定性错误。 */
export class ScriptedModelExhaustedError extends Error {}

/** 按预定义顺序返回计划的确定性 Model Port。 */
export class ScriptedModel implements ModelPort {
  /** 尚未消费的确定性计划序列；每次调用只取出队首计划。 */
  readonly #plans: ResearchPlan[];

  public constructor(plans: readonly ResearchPlan[]) {
    this.#plans = plans.map((plan) => parseResearchPlan(plan));
  }

  public async proposePlan(_request: PlanRequest): Promise<ResearchPlan> {
    const plan = this.#plans.shift();
    if (plan === undefined) {
      throw new ScriptedModelExhaustedError("Scripted Model 没有剩余计划输出");
    }

    // 返回副本，防止调用方对脚本夹具的意外修改影响后续断言。
    return structuredClone(plan);
  }
}
