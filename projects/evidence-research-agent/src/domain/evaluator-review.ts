import { hashCanonicalJson, hashUtf8Text } from "./integrity.js";
import type {
  ArtifactReference,
  EvaluatorClaimVerdict,
  EvaluatorReview,
  EvaluatorReviewIdentity,
  EvaluatorReviewRequest,
  EvidenceRecord,
  Claim,
  PublicationEvaluation,
  ReviewedPublicationEvaluation,
  SourceReadObservation,
} from "./types.js";

/** 从 Gate 选择与 completed source reads 构造隔离 review 输入。 */
export function buildEvaluatorReviewRequest(input: {
  /** 用户原始技术问题。 */
  readonly question: string;
  /** 已按 Artifact 展示顺序通过 Gate 的 Claims。 */
  readonly claims: readonly Claim[];
  /** Gate 已按首次引用顺序去重的 Evidence Records。 */
  readonly evidenceRecords: readonly EvidenceRecord[];
  /** 用于恢复 exact excerpt、但不会整体传给 evaluator 的来源 observations。 */
  readonly sourceReadObservations: readonly SourceReadObservation[];
}): EvaluatorReviewRequest {
  const evidenceById = new Map(
    input.evidenceRecords.map((evidence) => [evidence.evidenceId, evidence]),
  );
  const observationById = new Map(
    input.sourceReadObservations
      .filter((observation) => observation.status === "succeeded")
      .map((observation) => [observation.observationId, observation]),
  );
  return {
    question: input.question,
    claims: input.claims.map((claim) => ({
      claimId: claim.claimId,
      kind: claim.kind,
      text: claim.text,
      evidence: claim.evidenceIds.map((evidenceId) => {
        const evidence = evidenceById.get(evidenceId);
        const observation = evidence === undefined
          ? undefined
          : observationById.get(evidence.observationId);
        if (evidence === undefined || observation === undefined) {
          throw new EvaluatorReviewValidationError();
        }
        return {
          evidenceId: evidence.evidenceId,
          sourceSnapshotId: evidence.sourceSnapshotId,
          relativePath: evidence.relativePath,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
          excerpt: observation.excerpt,
        };
      }),
    })),
  };
}

/** Evaluator completed result 不覆盖 exact input Claims 时抛出的稳定领域错误。 */
export class EvaluatorReviewValidationError extends Error {
  public constructor() {
    super("Evaluator Review 结构无效");
    this.name = "EvaluatorReviewValidationError";
  }
}

/** 对 isolated evaluator input 计算可进入 review identity 的 canonical hash。 */
export function evaluatorInputHash(request: EvaluatorReviewRequest): string {
  return hashCanonicalJson(request);
}

/** 验证每个输入 Claim 恰好有一个同序 verdict，并冻结返回副本。 */
export function validateEvaluatorReview(
  request: EvaluatorReviewRequest,
  review: EvaluatorReview,
): EvaluatorReview {
  if (
    !isExactObject(review, ["verdicts"]) ||
    !Array.isArray(review.verdicts) ||
    review.verdicts.length !== request.claims.length ||
    review.verdicts.some(
      (verdict, index) =>
        !isExactObject(verdict, ["claimId", "verdict"]) ||
        typeof verdict.claimId !== "string" ||
        typeof verdict.verdict !== "string" ||
        verdict.claimId !== request.claims[index]?.claimId ||
        ![
          "supported",
          "partially_supported",
          "unsupported",
          "contradicted",
          "uncertain",
        ].includes(verdict.verdict),
    ) ||
    new Set(review.verdicts.map((verdict) => verdict.claimId)).size !==
      review.verdicts.length
  ) {
    throw new EvaluatorReviewValidationError();
  }
  return {
    verdicts: review.verdicts.map((verdict): EvaluatorClaimVerdict => ({
      claimId: verdict.claimId,
      verdict: verdict.verdict,
    })),
  };
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** 计算 `putJson(review)` 使用的 exact pretty JSON bytes hash。 */
export function evaluatorReviewArtifactHash(review: EvaluatorReview): string {
  return hashUtf8Text(`${JSON.stringify(review, null, 2)}\n`);
}

/** 构造并逐字段验证成功 review 的 publication evaluation。 */
export function createReviewedPublicationEvaluation(input: {
  /** 已通过 exact Claim coverage 校验的结构化 review。 */
  readonly review: EvaluatorReview;
  /** `putJson(review)` 返回的私有 content-addressed 引用。 */
  readonly reviewArtifact: ArtifactReference;
  /** 不含 input/review hash 的 evaluator model/prompt identity。 */
  readonly evaluatorIdentity: Omit<
    EvaluatorReviewIdentity,
    "inputHash" | "reviewArtifactHash"
  >;
  /** 对 exact isolated input 计算的 canonical hash。 */
  readonly inputHash: string;
}): ReviewedPublicationEvaluation {
  const expectedArtifactHash = evaluatorReviewArtifactHash(input.review);
  if (
    input.reviewArtifact.mediaType !== "application/json" ||
    input.reviewArtifact.sha256 !== expectedArtifactHash ||
    input.reviewArtifact.artifactId !== `sha256:${expectedArtifactHash}`
  ) {
    throw new EvaluatorReviewValidationError();
  }
  return {
    kind: "reviewed",
    review: input.review,
    reviewArtifact: input.reviewArtifact,
    identity: {
      ...input.evaluatorIdentity,
      inputHash: input.inputHash,
      reviewArtifactHash: expectedArtifactHash,
    },
  };
}

/** 不读取 CAS 时验证 review 投影、artifact 引用与 identity 的自洽内容身份。 */
export function validateReviewedPublicationEvaluation(
  request: EvaluatorReviewRequest,
  evaluation: ReviewedPublicationEvaluation,
): void {
  validateEvaluatorReview(request, evaluation.review);
  const expectedReviewHash = evaluatorReviewArtifactHash(evaluation.review);
  if (
    evaluation.identity.inputHash !== evaluatorInputHash(request) ||
    evaluation.identity.reviewArtifactHash !== expectedReviewHash ||
    evaluation.reviewArtifact.sha256 !== expectedReviewHash ||
    evaluation.reviewArtifact.artifactId !== `sha256:${expectedReviewHash}` ||
    evaluation.reviewArtifact.mediaType !== "application/json"
  ) {
    throw new EvaluatorReviewValidationError();
  }
}

/** publication binding 对 review artifact 或 explicit skip 使用的统一摘要。 */
export function publicationEvaluationHash(
  evaluation: PublicationEvaluation,
): string {
  return evaluation.kind === "reviewed"
    ? evaluation.reviewArtifact.sha256
    : hashCanonicalJson(evaluation.identity);
}
