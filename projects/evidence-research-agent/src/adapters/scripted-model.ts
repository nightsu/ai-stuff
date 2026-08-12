import {
  parseLearningArtifactProposal,
  parseResearchPlan,
} from "../domain/schemas.js";
import type {
  LearningArtifactProposal,
  ModelTurn,
  ModelView,
  ResearchPlan,
} from "../domain/types.js";
import type {
  LearningArtifactProposalRequest,
  ModelPort,
  PlanRequest,
} from "../application/ports.js";

/** 当测试脚本没有剩余模型输出时抛出的确定性错误。 */
export class ScriptedModelExhaustedError extends Error {}

/** 按预定义顺序返回计划的确定性 Model Port。 */
export class ScriptedModel implements ModelPort {
  /** 尚未消费的确定性计划序列；每次调用只取出队首计划。 */
  readonly #plans: ResearchPlan[];
  /** 尚未消费的 Learning Artifact 提案；只允许选择已有 Claim identities。 */
  readonly #learningArtifactProposals: LearningArtifactProposal[];
  /** 尚未消费的 Research Loop Model Turns。 */
  readonly #researchTurns: Omit<ModelTurn, "turnId" | "completedAt">[];
  /** 每次 generation 收到的结构化 Model View 副本，供 public seam 测试检查。 */
  public readonly researchViews: ModelView[] = [];
  /** 每次 draft generation 收到的结构化请求副本，用于验证预算阻断发生在模型调用前。 */
  public readonly learningArtifactRequests: LearningArtifactProposalRequest[] = [];

  public constructor(
    plans: readonly ResearchPlan[],
    learningArtifactProposals: readonly LearningArtifactProposal[] = [],
    researchTurns: readonly Omit<ModelTurn, "turnId" | "completedAt">[] = [],
  ) {
    this.#plans = plans.map((plan) => parseResearchPlan(plan));
    this.#learningArtifactProposals = learningArtifactProposals.map((proposal) =>
      parseLearningArtifactProposal(proposal),
    );
    this.#researchTurns = researchTurns.map((turn) => structuredClone(turn));
  }

  public async proposePlan(_request: PlanRequest): Promise<ResearchPlan> {
    const plan = this.#plans.shift();
    if (plan === undefined) {
      throw new ScriptedModelExhaustedError("Scripted Model 没有剩余计划输出");
    }

    // 返回副本，防止调用方对脚本夹具的意外修改影响后续断言。
    return structuredClone(plan);
  }

  public async proposeLearningArtifact(
    request: LearningArtifactProposalRequest,
  ): Promise<LearningArtifactProposal> {
    const proposal = this.#learningArtifactProposals.shift();
    if (proposal === undefined) {
      throw new ScriptedModelExhaustedError("Scripted Model 没有剩余 Learning Artifact 提案");
    }

    this.learningArtifactRequests.push(structuredClone(request));
    // 运行时会把这里的 claimIds 与 durable Projection 再次交叉验证；脚本只模拟
    // 模型选择，不能成为引用事实源或绕过 Evidence Gate。
    return structuredClone(proposal);
  }

  public async generateResearchTurn(
    view: ModelView,
  ): Promise<Omit<ModelTurn, "turnId" | "completedAt">> {
    const turn = this.#researchTurns.shift();
    if (turn === undefined) {
      throw new ScriptedModelExhaustedError("Scripted Model 没有剩余 Research Loop 输出");
    }
    this.researchViews.push(structuredClone(view));
    return structuredClone(turn);
  }
}
