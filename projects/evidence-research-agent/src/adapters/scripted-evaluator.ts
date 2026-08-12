import type { EvaluatorPort } from "../application/ports.js";
import type {
  EvaluatorIdentity,
  EvaluatorReview,
  EvaluatorReviewRequest,
  EvaluatorVerdict,
} from "../domain/types.js";

/** Scripted Evaluator 可顺序返回的完整结果或确定性 failure。 */
export type ScriptedEvaluatorResult = EvaluatorReview | Error;

/** 独立于 Scripted Model 的 deterministic Evaluator Port。 */
export class ScriptedEvaluator implements EvaluatorPort {
  /** 可持久化且不含 credential 的 evaluator model/prompt identity。 */
  public readonly identity: EvaluatorIdentity;
  /** 每次 review 收到的 isolated request 副本，供 Runtime public seam 断言。 */
  public readonly requests: EvaluatorReviewRequest[] = [];
  /** 尚未消费的显式 scripted results；空时按默认 verdict 生成完整 review。 */
  readonly #results: ScriptedEvaluatorResult[];
  /** 没有显式 result 时对每个输入 Claim 返回的封闭 verdict。 */
  readonly #defaultVerdict: EvaluatorVerdict;

  public constructor(
    results: readonly ScriptedEvaluatorResult[] = [],
    identity: EvaluatorIdentity = {
      provider: "scripted",
      model: "scripted-evaluator",
      promptVersion: "evidence-evaluator-v1",
    },
    defaultVerdict: EvaluatorVerdict = "supported",
  ) {
    this.#results = [...results];
    this.identity = Object.freeze({ ...identity });
    this.#defaultVerdict = defaultVerdict;
  }

  public async reviewClaims(
    request: EvaluatorReviewRequest,
  ): Promise<EvaluatorReview> {
    this.requests.push(structuredClone(request));
    const result = this.#results.shift();
    if (result instanceof Error) throw result;
    if (result !== undefined) return structuredClone(result);
    return {
      verdicts: request.claims.map((claim) => ({
        claimId: claim.claimId,
        verdict: this.#defaultVerdict,
      })),
    };
  }
}
