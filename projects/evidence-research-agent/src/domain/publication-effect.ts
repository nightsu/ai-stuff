import { hashCanonicalJson } from "./integrity.js";
import type {
  ConflictingPublicationEffect,
  ExecutingPublicationEffect,
  PendingPublicationEffect,
  PublicationApprovalReceipt,
  PublicationTarget,
  SucceededPublicationEffect,
  UnknownPublicationEffect,
} from "./types.js";

/** 为一个已批准 draft/target action 构造跨重启稳定的 Publication Effect。 */
export function createPendingPublicationEffect(input: {
  /** Publication Effect 所属的 Research Run identity。 */
  readonly runId: string;
  /** 用户批准的 exact Markdown draft SHA-256。 */
  readonly draftHash: string;
  /** 用户批准且刚重新验证的 canonical publication target。 */
  readonly publicationTarget: PublicationTarget;
  /** 授权本 action 的 exact Publication Approval Receipt。 */
  readonly publicationReceipt: PublicationApprovalReceipt;
  /** prepare 事实进入 Journal 的 ISO 8601 UTC 时间。 */
  readonly preparedAt: string;
}): PendingPublicationEffect {
  const effectHash = hashCanonicalJson({
    runId: input.runId,
    draftHash: input.draftHash,
    targetCanonicalPath: input.publicationTarget.targetCanonicalPath,
  });
  return {
    effectId: `publication-effect:${effectHash}`,
    runId: input.runId,
    draftHash: input.draftHash,
    targetCanonicalPath: input.publicationTarget.targetCanonicalPath,
    publicationApprovalId: input.publicationReceipt.approvalId,
    status: "pending",
    preparedAt: input.preparedAt,
  };
}

/** 从 exact PENDING identity 派生 EXECUTING，不创建新的 action。 */
export function startPublicationEffect(
  effect: PendingPublicationEffect,
  executionStartedAt: string,
): ExecutingPublicationEffect {
  return { ...effect, status: "executing", executionStartedAt };
}

/** 将 crash window 显式结算为 UNKNOWN，等待用户发起 reconcile。 */
export function markPublicationEffectUnknown(
  effect:
    | ExecutingPublicationEffect
    | UnknownPublicationEffect
    | ConflictingPublicationEffect,
  unknownAt: string,
  reason: UnknownPublicationEffect["reason"],
): UnknownPublicationEffect {
  return {
    ...startedIdentity(effect),
    status: "unknown",
    unknownAt,
    reason,
  };
}

/** 将安全观察到的不同 target 内容持久化为 CONFLICT。 */
export function markPublicationEffectConflict(
  effect:
    | ExecutingPublicationEffect
    | UnknownPublicationEffect
    | ConflictingPublicationEffect,
  conflictedAt: string,
  observedTargetHash?: string,
): ConflictingPublicationEffect {
  return {
    ...startedIdentity(effect),
    status: "conflict",
    conflictedAt,
    ...(observedTargetHash === undefined ? {} : { observedTargetHash }),
  };
}

/** matching target 或当前执行返回后，把 effect 结算为 SUCCEEDED。 */
export function succeedPublicationEffect(
  effect:
    | ExecutingPublicationEffect
    | UnknownPublicationEffect
    | ConflictingPublicationEffect,
  succeededAt: string,
  settlement: SucceededPublicationEffect["settlement"],
): SucceededPublicationEffect {
  return {
    ...startedIdentity(effect),
    status: "succeeded",
    succeededAt,
    settlement,
  };
}

/** missing target 证明无 external effect，可保留 identity 安全回到 PENDING。 */
export function retryPendingPublicationEffect(
  effect: UnknownPublicationEffect | ConflictingPublicationEffect,
): PendingPublicationEffect {
  return {
    effectId: effect.effectId,
    runId: effect.runId,
    draftHash: effect.draftHash,
    targetCanonicalPath: effect.targetCanonicalPath,
    publicationApprovalId: effect.publicationApprovalId,
    preparedAt: effect.preparedAt,
    status: "pending",
  };
}

function startedIdentity(
  effect:
    | ExecutingPublicationEffect
    | UnknownPublicationEffect
    | ConflictingPublicationEffect,
): Omit<ExecutingPublicationEffect, "status"> {
  return {
    effectId: effect.effectId,
    runId: effect.runId,
    draftHash: effect.draftHash,
    targetCanonicalPath: effect.targetCanonicalPath,
    publicationApprovalId: effect.publicationApprovalId,
    preparedAt: effect.preparedAt,
    executionStartedAt: effect.executionStartedAt,
  };
}
