import { isAbsolute } from "node:path";

import {
  assertEvidenceGateBudget,
  EvidenceGateError,
  evaluateEvidenceGate,
} from "./evidence-gate.js";
import {
  calculateRemainingRunBudget,
  countLogicalToolCalls,
  firstExhaustedRunBudgetDimension,
  RunBudgetCalculationError,
} from "./run-budget.js";
import {
  hasPreRenderedCitationToken,
  PreRenderedCitationTokenError,
} from "./citation-safety.js";
import {
  artifactReferenceHasMatchingContentIdentity,
  createPlanApprovalBinding,
  hashReadSourceRequest,
  hashUtf8Text,
  sourceSnapshotHasMatchingContentIdentity,
} from "./integrity.js";
import {
  createPublicationApprovalBinding,
  publicationBindingsEqual,
  renderLearningArtifact,
} from "./learning-artifact.js";
import {
  sourcePathPolicyDenial,
  sourceRequestDenial,
} from "./source-policy.js";
import type {
  Claim,
  EvidenceRecord,
  ArtifactReference,
  LearningArtifactDraftProposedPayload,
  PlanApprovalBinding,
  PublicationApprovalBinding,
  PublicationApprovalReceipt,
  PublicationTarget,
  PublishedLearningArtifact,
  ResearchRunEvent,
  ResearchToolIntent,
  ResearchToolObservation,
  ResearchingRunState,
  RunProjection,
  SourceReadObservation,
  RunTrace,
  RunTraceEvent,
} from "./types.js";

export class IllegalRunEventError extends Error {}

const stableSourceDenialCodes = new Set<string>([
  "invalid_root",
  "invalid_path",
  "invalid_line_range",
  "line_range_out_of_bounds",
  "path_escape",
  "symlink_escape",
  "symlink_path",
  "excluded_path",
  "secret_path",
  "extension_not_allowed",
  "binary_file",
  "file_too_large",
  "source_budget_exceeded",
  "line_range_too_large",
]);

const stableSourceFailureCodes = new Set<string>([
  "root_changed",
  "path_changed_during_read",
  "source_changed_during_read",
  "source_not_found",
  "source_not_file",
  "source_io_error",
]);

export function reduceRunEvents(
  events: readonly ResearchRunEvent[],
): RunProjection {
  let projection: RunProjection | undefined;

  for (const event of events) {
    projection = applyRunEvent(projection, event);
  }

  if (projection === undefined) {
    throw new IllegalRunEventError("空 Journal 无法派生 Run Projection");
  }

  return projection;
}

export function buildRunTrace(events: readonly ResearchRunEvent[]): RunTrace {
  let projection: RunProjection | undefined;
  const traceEvents: RunTraceEvent[] = [];

  for (const event of events) {
    projection = applyRunEvent(projection, event);
    const lineage = traceLineage(event);
    traceEvents.push({
      sequence: event.sequence,
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      stateAfter: projection.state.type,
      ...lineage,
    });
  }

  if (projection === undefined) {
    throw new IllegalRunEventError("空 Journal 无法派生 Run Trace");
  }

  return {
    runId: projection.runId,
    finalState: projection.state.type,
    events: traceEvents,
  };
}

function applyRunEvent(
  current: RunProjection | undefined,
  event: ResearchRunEvent,
): RunProjection {
  // reducer 是唯一合法状态转换入口：数据库缓存、CLI 和测试都只能回放事实，
  // 不能通过直接修改 status 绕过状态机。
  if (current === undefined) {
    if (event.type !== "run_created" || event.sequence !== 1) {
      throw new IllegalRunEventError("Run Journal 必须以 #1 run_created 开始");
    }

    return {
      runId: event.runId,
      question: event.payload.question,
      sourceScope: event.payload.sourceScope,
      runBudget: event.payload.runBudget,
      state: { type: "created" },
      lastEventSequence: event.sequence,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
  }

  if (event.runId !== current.runId) {
    throw new IllegalRunEventError("同一次回放不能混入其他 Run 的事件");
  }
  if (event.sequence !== current.lastEventSequence + 1) {
    throw new IllegalRunEventError("Run Journal 事件序号必须严格连续");
  }

  switch (event.type) {
    case "run_created":
      throw new IllegalRunEventError("run_created 只能是 Run 的第一个事件");
    case "planning_started": {
      if (current.state.type !== "created") {
        throw new IllegalRunEventError("只有 created Run 可以开始规划");
      }
      return {
        ...current,
        state: { type: "planning", startedAt: event.occurredAt },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "plan_proposed": {
      if (current.state.type !== "planning") {
        throw new IllegalRunEventError("只有 planning Run 可以提交计划");
      }
      // reducer 也是可直接调用的领域边界，不能假设事件一定先经过 Zod。
      // identity 与摘要若命名不同对象，planHash 即使正确也无法授权该引用。
      if (
        !artifactReferenceHasMatchingContentIdentity(
          event.payload.planArtifact,
        )
      ) {
        throw new IllegalRunEventError(
          "plan_proposed artifact identity 与内容摘要不一致",
        );
      }
      const expectedApprovalBinding = createPlanApprovalBinding({
        question: current.question,
        planHash: event.payload.planArtifact.sha256,
        sourceScope: current.sourceScope,
        runBudget: current.runBudget,
      });
      // approvalBinding 是方便审计的冗余摘要，不是新的事实源。回放必须从
      // run_created 与 plan artifact 重新计算，否则被篡改但内部自洽的摘要
      // 会把 Journal 中未授权的问题、范围或预算伪装成有效审批边界。
      if (
        !approvalBindingsEqual(
          expectedApprovalBinding,
          event.payload.approvalBinding,
        )
      ) {
        throw new IllegalRunEventError(
          "plan_proposed 审批绑定与当前 Run 事实不一致",
        );
      }
      return {
        ...current,
        state: {
          type: "waiting_plan_approval",
          planArtifact: event.payload.planArtifact,
          approvalBinding: expectedApprovalBinding,
          proposedAt: event.occurredAt,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "plan_approved": {
      if (current.state.type !== "waiting_plan_approval") {
        throw new IllegalRunEventError(
          "只有 waiting_plan_approval Run 可以批准计划",
        );
      }

      const { approvalReceipt } = event.payload;
      const expectedApprovalBinding = createPlanApprovalBinding({
        question: current.question,
        planHash: current.state.planArtifact.sha256,
        sourceScope: current.sourceScope,
        runBudget: current.runBudget,
      });
      // Receipt 是回放时唯一持久化的用户授权事实，因此既要重新确认等待状态的
      // artifact/binding 不变量，也要逐字段匹配完整 Receipt；actor 或 kind 即使被
      // 直接塞进类型化对象，也不能绕过 schema 后获得授权。
      if (
        !artifactReferenceHasMatchingContentIdentity(
          current.state.planArtifact,
        ) ||
        !approvalBindingsEqual(
          expectedApprovalBinding,
          current.state.approvalBinding,
        ) ||
        approvalReceipt.kind !== "plan" ||
        approvalReceipt.approvedBy !== "user-command" ||
        approvalReceipt.approvalId.trim() === "" ||
        approvalReceipt.approvedAt !== event.occurredAt ||
        approvalReceipt.planHash !== current.state.planArtifact.sha256 ||
        !approvalBindingsEqual(expectedApprovalBinding, approvalReceipt)
      ) {
        throw new IllegalRunEventError(
          "plan_approved Receipt 与等待审批边界不一致",
        );
      }

      return {
        ...current,
        state: {
          type: "researching",
          planArtifact: current.state.planArtifact,
          approvalReceipt,
          sourceReadObservations: [],
          sourceBytesRead: 0,
          evidenceRecords: [],
          claims: [],
          modelTurns: [],
          researchToolObservations: [],
          evidenceGaps: [],
          pendingToolIntents: [],
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "model_turn_completed": {
      if (current.state.type !== "researching") {
        throw new IllegalRunEventError("只有 researching Run 可以提交 Model Turn");
      }
      if (current.state.pendingToolIntents.length !== 0) {
        throw new IllegalRunEventError("pending Research Tool intent 尚未获得 observation");
      }
      const { turn } = event.payload;
      if (
        turn.turnId !== `turn-${event.eventId}` ||
        turn.completedAt !== event.occurredAt ||
        !isIsoUtc(turn.completedAt) ||
        turn.toolIntents.length === 0 ||
        new Set(turn.toolIntents.map((intent) => intent.intentId)).size !==
          turn.toolIntents.length ||
        turn.toolIntents.some(
          (intent) =>
            intent.intentId.trim() === "" ||
            ![
              "search_sources",
              "read_source",
              "record_evidence",
              "propose_claim",
              "complete_research",
            ].includes(intent.name),
        ) ||
        current.state.modelTurns.length + 2 > current.runBudget.maxModelTurns
        || !isIsoUtc(event.payload.generationStartedAt)
        || Date.parse(event.payload.generationStartedAt) > Date.parse(event.occurredAt)
      ) {
        throw new IllegalRunEventError("Model Turn 公共字段无效");
      }
      return {
        ...current,
        state: {
          ...current.state,
          modelTurns: [...current.state.modelTurns, turn],
          evidenceGaps: turn.evidenceGaps,
          pendingToolIntents: turn.toolIntents,
          ...(event.payload.latestSteering === undefined
            ? {}
            : { latestSteering: event.payload.latestSteering }),
          researchStartedAt:
            current.state.researchStartedAt ?? event.payload.generationStartedAt,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "research_tool_observed": {
      if (current.state.type !== "researching") {
        throw new IllegalRunEventError("只有 researching Run 可以记录 Research Tool observation");
      }
      const pending = validateResearchObservation(
        current.state.pendingToolIntents,
        current.state.researchToolObservations,
        event.payload.observation,
        event.occurredAt,
      );
      const output = event.payload.observation.output;
      assertResearchToolCallWithinBudget(current, event.payload.observation);
      if (event.payload.observation.status === "succeeded") {
        if (
          event.payload.observation.toolName !== "search_sources" ||
          output === undefined ||
          !("searchResultArtifact" in output) ||
          !artifactReferenceHasMatchingContentIdentity(output.searchResultArtifact) ||
          output.searchResultArtifact.mediaType !== "application/json" ||
          !Number.isSafeInteger(output.matchCount) ||
          output.matchCount < 0
        ) {
          // read/evidence/claim/completion 的成功事实各有专属领域事件；generic
          // observation 只能承载 search success 或安全的非成功反馈。
          throw new IllegalRunEventError("generic Research Tool success 无效");
        }
      } else if (output !== undefined) {
        throw new IllegalRunEventError("非成功 Research Tool observation 不能携带 output");
      }
      return {
        ...current,
        state: {
          ...current.state,
          researchToolObservations: [
            ...current.state.researchToolObservations,
            event.payload.observation,
          ],
          pendingToolIntents: pending,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "source_read_observed": {
      if (current.state.type !== "researching") {
        throw new IllegalRunEventError(
          "只有 researching Run 可以记录来源读取 observation",
        );
      }
      const observation = event.payload.observation;
      assertResearchToolCallWithinBudget(
        current,
        event.payload.researchObservation ?? observation,
      );
      if (
        event.payload.researchObservation !== undefined &&
        (event.payload.researchObservation.observationId !==
          observation.observationId ||
          event.payload.researchObservation.toolCallId !== observation.toolCallId ||
          event.payload.researchObservation.toolName !== "read_source" ||
          event.payload.researchObservation.status !== observation.status ||
          (observation.status === "succeeded"
            ? !hasExactOutput(
                event.payload.researchObservation.output,
                "sourceObservationId",
                observation.observationId,
              )
            : event.payload.researchObservation.code !== observation.code ||
              event.payload.researchObservation.output !== undefined))
      ) {
        throw new IllegalRunEventError("read_source 领域 observation 与模型 observation 不一致");
      }
      validateSourceReadObservation(
        current.sourceScope,
        current.state.sourceReadObservations,
        observation,
        event.occurredAt,
      );

      // sourceBytesRead 是 Journal 的派生量。每次回放都从成功 observation 重新
      // 求和，拒绝相信事件或缓存声称的 counter，避免篡改累计预算事实。
      const priorSourceBytes = sourceBytesFromObservations(
        current.state.sourceReadObservations,
      );
      if (priorSourceBytes !== current.state.sourceBytesRead) {
        throw new IllegalRunEventError("来源读取累计字节派生值不一致");
      }
      const sourceBytesRead =
        priorSourceBytes +
        (observation.status === "succeeded" ? observation.byteLength : 0);
      const approvedByteLimit = Math.min(
        current.sourceScope.maxTotalBytes,
        current.runBudget.maxSourceBytes,
      );
      if (sourceBytesRead > approvedByteLimit) {
        throw new IllegalRunEventError("来源读取 observation 超出批准累计字节限制");
      }
      const distinctSources = new Set(
        [...current.state.sourceReadObservations, observation].flatMap((candidate) =>
          candidate.status === "succeeded"
            ? [candidate.sourceSnapshot.snapshotId]
            : [],
        ),
      ).size;
      if (distinctSources > current.runBudget.maxDistinctSources) {
        throw new IllegalRunEventError("来源读取 observation 超出批准 distinct source 限制");
      }

      return {
        ...current,
        state: {
          ...current.state,
          sourceReadObservations: [
            ...current.state.sourceReadObservations,
            observation,
          ],
          sourceBytesRead,
          ...consumeEmbeddedResearchObservation(
            current.state,
            event.payload.researchObservation,
            event.occurredAt,
          ),
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "evidence_recorded": {
      if (current.state.type !== "researching") {
        throw new IllegalRunEventError(
          "只有 researching Run 可以登记 Evidence Record",
        );
      }
      validateEvidenceRecord(
        current.state.sourceReadObservations,
        current.state.evidenceRecords,
        event.payload.evidence,
        event.occurredAt,
      );
      validateEmbeddedSuccessObservation(
        current,
        event.payload.researchObservation,
        "record_evidence",
        "evidenceId",
        event.payload.evidence.evidenceId,
        event.occurredAt,
      );
      return {
        ...current,
        state: {
          ...current.state,
          evidenceRecords: [
            ...current.state.evidenceRecords,
            event.payload.evidence,
          ],
          ...consumeEmbeddedResearchObservation(
            current.state,
            event.payload.researchObservation,
            event.occurredAt,
          ),
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "claim_recorded": {
      if (current.state.type !== "researching") {
        throw new IllegalRunEventError("只有 researching Run 可以登记 Claim");
      }
      validateClaim(
        current.state.evidenceRecords,
        current.state.claims,
        event.payload.claim,
        event.occurredAt,
      );
      validateEmbeddedSuccessObservation(
        current,
        event.payload.researchObservation,
        "propose_claim",
        "claimId",
        event.payload.claim.claimId,
        event.occurredAt,
      );
      return {
        ...current,
        state: {
          ...current.state,
          claims: [...current.state.claims, event.payload.claim],
          ...consumeEmbeddedResearchObservation(
            current.state,
            event.payload.researchObservation,
            event.occurredAt,
          ),
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "research_completed": {
      if (current.state.type !== "researching") {
        throw new IllegalRunEventError("只有 researching Run 可以显式完成研究");
      }
      const remaining = validateResearchObservation(
        current.state.pendingToolIntents,
        current.state.researchToolObservations,
        event.payload.observation,
        event.occurredAt,
      );
      assertResearchToolCallWithinBudget(current, event.payload.observation);
      if (
        event.payload.observation.toolName !== "complete_research" ||
        event.payload.observation.status !== "succeeded" ||
        event.payload.observation.code !== undefined ||
        !hasExactUnresolvedQuestionsOutput(
          event.payload.observation.output,
          event.payload.completion.unresolvedQuestions,
        ) ||
        remaining.length !== 0 ||
        event.payload.completion.completedAt !== event.occurredAt ||
        !isIsoUtc(event.payload.completion.completedAt)
      ) {
        throw new IllegalRunEventError("Research completion 与 pending intent 不一致");
      }
      return {
        ...current,
        state: {
          ...current.state,
          type: "research_complete",
          pendingToolIntents: [],
          researchToolObservations: [
            ...current.state.researchToolObservations,
            event.payload.observation,
          ],
          completion: event.payload.completion,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "run_budget_exhausted": {
      if (current.state.type !== "researching") {
        throw new IllegalRunEventError("只有 researching Run 可以因预算暂停");
      }
      const expectedRemaining = remainingBudgetFromProjection(
        current,
        event.occurredAt,
      );
      const expectedDimension = firstExhaustedRunBudgetDimension(
        expectedRemaining,
        current.state.pendingToolIntents.length === 0 ? "model" : "tool",
      );
      if (
        expectedDimension !== event.payload.exhaustedDimension ||
        !remainingBudgetsEqual(expectedRemaining, event.payload.remainingBudget)
      ) {
        throw new IllegalRunEventError("budget_exhausted 事件与 canonical usage 不一致");
      }
      return {
        ...current,
        state: {
          ...current.state,
          type: "budget_exhausted",
          exhaustedDimension: event.payload.exhaustedDimension,
          remainingBudget: event.payload.remainingBudget,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "learning_artifact_draft_proposed": {
      if (
        current.state.type !== "researching" &&
        current.state.type !== "research_complete"
      ) {
        throw new IllegalRunEventError(
          "只有 researching Run 可以提出 Learning Artifact draft",
        );
      }
      if (
        current.state.modelTurns.length > 0 &&
        current.state.type !== "research_complete"
      ) {
        throw new IllegalRunEventError(
          "进入 Research Loop 后必须先显式完成研究",
        );
      }
      validateLearningArtifactDraft(current, event.payload, event.occurredAt);
      return {
        ...current,
        state: {
          ...current.state,
          type: "waiting_publication_approval",
          draftArtifact: event.payload.draftArtifact,
          proposal: event.payload.proposal,
          publicationTarget: event.payload.publicationTarget,
          publicationBinding: event.payload.publicationBinding,
          proposedAt: event.occurredAt,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "publication_approved": {
      if (current.state.type !== "waiting_publication_approval") {
        throw new IllegalRunEventError(
          "只有 waiting_publication_approval Run 可以批准发布",
        );
      }
      validatePublicationApprovalReceipt(
        current.state.draftArtifact,
        current.state.publicationTarget,
        current.state.publicationBinding,
        event.payload.publicationReceipt,
        event.occurredAt,
      );
      const { proposedAt: _proposedAt, ...readyFields } = current.state;
      return {
        ...current,
        state: {
          ...readyFields,
          type: "ready_to_publish",
          publicationReceipt: event.payload.publicationReceipt,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
    case "learning_artifact_published": {
      if (current.state.type !== "ready_to_publish") {
        throw new IllegalRunEventError(
          "只有 ready_to_publish Run 可以确认 Learning Artifact 已发布",
        );
      }
      validatePublishedLearningArtifact(
        current.state.draftArtifact,
        current.state.publicationTarget,
        event.payload.learningArtifact,
        event.occurredAt,
      );
      return {
        ...current,
        state: {
          ...current.state,
          type: "completed",
          learningArtifact: event.payload.learningArtifact,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
  }
}

function remainingBudgetFromProjection(
  projection: RunProjection,
  evaluatedAt: string,
): import("./types.js").RemainingRunBudget {
  if (projection.state.type !== "researching") {
    throw new IllegalRunEventError("只有 researching Projection 可计算剩余预算");
  }
  try {
    return calculateRemainingRunBudget({
      runBudget: projection.runBudget,
      state: projection.state,
      evaluatedAt,
    });
  } catch (error) {
    if (error instanceof RunBudgetCalculationError) {
      throw new IllegalRunEventError(error.message);
    }
    throw error;
  }
}

function remainingBudgetsEqual(
  left: import("./types.js").RemainingRunBudget,
  right: import("./types.js").RemainingRunBudget,
): boolean {
  return (
    left.modelTurns === right.modelTurns &&
    left.toolCalls === right.toolCalls &&
    left.distinctSources === right.distinctSources &&
    left.sourceBytes === right.sourceBytes &&
    left.wallTimeMs === right.wallTimeMs
  );
}

function traceLineage(
  event: ResearchRunEvent,
): Pick<
  RunTraceEvent,
  | "toolCallId"
  | "observationId"
  | "observationStatus"
  | "sourceSnapshotId"
  | "evidenceId"
  | "claimId"
  | "draftArtifactId"
  | "publicationApprovalId"
  | "learningArtifactSha256"
> {
  if (event.type === "source_read_observed") {
    return {
      toolCallId: event.payload.observation.toolCallId,
      observationId: event.payload.observation.observationId,
      observationStatus: event.payload.observation.status,
      ...(event.payload.observation.status === "succeeded"
        ? {
            sourceSnapshotId:
              event.payload.observation.sourceSnapshot.snapshotId,
          }
        : {}),
    };
  }
  if (event.type === "research_tool_observed") {
    return {
      toolCallId: event.payload.observation.toolCallId,
      observationId: event.payload.observation.observationId,
      observationStatus:
        event.payload.observation.status === "succeeded" ? "succeeded" : "failed",
    };
  }
  if (event.type === "research_completed") {
    return {
      toolCallId: event.payload.observation.toolCallId,
      observationId: event.payload.observation.observationId,
      observationStatus: "succeeded",
    };
  }
  if (event.type === "evidence_recorded") {
    return {
      evidenceId: event.payload.evidence.evidenceId,
      observationId: event.payload.evidence.observationId,
      toolCallId: event.payload.evidence.toolCallId,
      sourceSnapshotId: event.payload.evidence.sourceSnapshotId,
    };
  }
  if (event.type === "claim_recorded") {
    return { claimId: event.payload.claim.claimId };
  }
  if (event.type === "learning_artifact_draft_proposed") {
    return { draftArtifactId: event.payload.draftArtifact.artifactId };
  }
  if (event.type === "publication_approved") {
    return { publicationApprovalId: event.payload.publicationReceipt.approvalId };
  }
  if (event.type === "learning_artifact_published") {
    return { learningArtifactSha256: event.payload.learningArtifact.sha256 };
  }
  return {};
}

function consumeEmbeddedResearchObservation(
  state: ResearchingRunState,
  observation: ResearchToolObservation | undefined,
  occurredAt: string,
): Pick<
  typeof state,
  "researchToolObservations" | "pendingToolIntents"
> {
  if (observation === undefined) {
    return {
      researchToolObservations: state.researchToolObservations,
      pendingToolIntents: state.pendingToolIntents,
    };
  }
  return {
    researchToolObservations: [...state.researchToolObservations, observation],
    pendingToolIntents: validateResearchObservation(
      state.pendingToolIntents,
      state.researchToolObservations,
      observation,
      occurredAt,
    ),
  };
}

function validateEmbeddedSuccessObservation(
  projection: RunProjection,
  observation: ResearchToolObservation | undefined,
  toolName: "record_evidence" | "propose_claim",
  outputKey: "evidenceId" | "claimId",
  outputIdentity: string,
  occurredAt: string,
): void {
  if (observation === undefined) return;
  if (projection.state.type !== "researching") {
    throw new IllegalRunEventError("只有 researching Run 可以消费 Research Tool intent");
  }
  assertResearchToolCallWithinBudget(projection, observation);
  if (
    observation.toolName !== toolName ||
    observation.status !== "succeeded" ||
    observation.code !== undefined ||
    !hasExactOutput(observation.output, outputKey, outputIdentity)
  ) {
    throw new IllegalRunEventError(`${toolName} 成功 observation 与领域事实不一致`);
  }
  validateResearchObservation(
    projection.state.pendingToolIntents,
    projection.state.researchToolObservations,
    observation,
    occurredAt,
  );
}

function assertResearchToolCallWithinBudget(
  projection: RunProjection,
  observation: Pick<ResearchToolObservation, "toolCallId">,
): void {
  if (projection.state.type !== "researching") {
    throw new IllegalRunEventError("只有 researching Run 可以消费 Research Tool budget");
  }
  const usedToolCallIds = new Set([
    ...projection.state.sourceReadObservations.map((item) => item.toolCallId),
    ...projection.state.researchToolObservations.map((item) => item.toolCallId),
  ]);
  usedToolCallIds.add(observation.toolCallId);
  if (usedToolCallIds.size > projection.runBudget.maxToolCalls) {
    throw new IllegalRunEventError("Research Tool observation 超出批准 tool call 限制");
  }
}

function hasExactOutput(
  output: ResearchToolObservation["output"],
  key: "sourceObservationId" | "evidenceId" | "claimId",
  identity: string,
): boolean {
  if (output === undefined || !hasExactKeys(output, [key])) return false;
  switch (key) {
    case "sourceObservationId":
      return "sourceObservationId" in output &&
        output.sourceObservationId === identity;
    case "evidenceId":
      return "evidenceId" in output && output.evidenceId === identity;
    case "claimId":
      return "claimId" in output && output.claimId === identity;
  }
}

function hasExactUnresolvedQuestionsOutput(
  output: ResearchToolObservation["output"],
  unresolvedQuestions: readonly string[],
): boolean {
  return (
    output !== undefined &&
    hasExactKeys(output, ["unresolvedQuestions"]) &&
    "unresolvedQuestions" in output &&
    output.unresolvedQuestions.length === unresolvedQuestions.length &&
    output.unresolvedQuestions.every(
      (question, index) => question === unresolvedQuestions[index],
    )
  );
}

function validateResearchObservation(
  pendingIntents: readonly ResearchToolIntent[],
  priorObservations: readonly ResearchToolObservation[],
  observation: ResearchToolObservation,
  occurredAt: string,
): readonly ResearchToolIntent[] {
  const intent = pendingIntents[0];
  if (
    intent === undefined ||
    observation.intentId !== intent.intentId ||
    observation.toolName !== intent.name ||
    observation.observationId.trim() === "" ||
    observation.toolCallId.trim() === "" ||
    observation.summary.trim() === "" ||
    observation.observedAt !== occurredAt ||
    !isIsoUtc(observation.observedAt) ||
    priorObservations.some(
      (prior) =>
        prior.observationId === observation.observationId ||
        prior.toolCallId === observation.toolCallId,
    ) ||
    (observation.status === "succeeded"
      ? observation.code !== undefined
      : observation.code === undefined || observation.output !== undefined)
  ) {
    throw new IllegalRunEventError("Research Tool observation 未精确消费 pending intent");
  }
  return pendingIntents.slice(1);
}

function validateSourceReadObservation(
  sourceScope: RunProjection["sourceScope"],
  observations: readonly SourceReadObservation[],
  observation: SourceReadObservation,
  occurredAt: string,
): void {
  if (
    observation.observationId.trim() === "" ||
    observation.toolCallId.trim() === "" ||
    observation.toolName !== "read_source" ||
    !isSha256(observation.requestHash) ||
    observation.observedAt !== occurredAt ||
    !isIsoUtc(observation.observedAt) ||
    observations.some(
      (prior) => prior.observationId === observation.observationId,
    ) ||
    observations.some((prior) => prior.toolCallId === observation.toolCallId)
  ) {
    throw new IllegalRunEventError("来源读取 observation 公共 lineage 无效");
  }

  if (observation.status === "succeeded") {
    if (!hasExactSucceededShape(observation)) {
      throw new IllegalRunEventError("成功来源读取 observation 形状无效");
    }
    const persistedRequest = {
      rootIndex: observation.rootIndex,
      relativePath: observation.relativePath,
      startLine: observation.startLine,
      endLine: observation.endLine,
    };
    if (
      sourceRequestDenial(
        persistedRequest,
        sourceScope.roots.length,
        Number.MAX_SAFE_INTEGER,
      ) !== undefined ||
      sourcePathPolicyDenial(
        observation.relativePath,
        sourceScope,
      ) !== undefined ||
      hashReadSourceRequest(persistedRequest) !== observation.requestHash ||
      !Number.isSafeInteger(observation.totalLines) ||
      observation.totalLines <= 0 ||
      observation.endLine > observation.totalLines ||
      observation.excerpt.includes("\0") ||
      observation.excerpt.includes("\r") ||
      observation.excerpt.split("\n").length !==
        observation.endLine - observation.startLine + 1 ||
      hashUtf8Text(observation.excerpt) !== observation.excerptHash ||
      !sourceSnapshotHasMatchingContentIdentity(
        observation.sourceSnapshot,
      ) ||
      !hasExactKeys(observation.sourceSnapshot, [
        "snapshotId",
        "sha256",
        "mediaType",
        "byteLength",
        "relativePath",
      ]) ||
      !isSha256(observation.sourceSnapshot.sha256) ||
      observation.sourceSnapshot.mediaType !== "text/plain; charset=utf-8" ||
      !Number.isSafeInteger(observation.byteLength) ||
      observation.byteLength <= 0 ||
      observation.sourceSnapshot.byteLength !== observation.byteLength
    ) {
      throw new IllegalRunEventError("成功来源读取 observation 完整性无效");
    }
    return;
  }

  if (
    !hasExactNonSuccessShape(observation) ||
    (observation.status === "denied" &&
      !stableSourceDenialCodes.has(observation.code)) ||
    (observation.status === "failed" &&
      !stableSourceFailureCodes.has(observation.code))
  ) {
    throw new IllegalRunEventError("非成功来源读取 observation 形状无效");
  }
}

function validateEvidenceRecord(
  observations: readonly SourceReadObservation[],
  evidenceRecords: readonly EvidenceRecord[],
  evidence: EvidenceRecord,
  occurredAt: string,
): void {
  if (
    !hasExactKeys(evidence, [
      "evidenceId",
      "kind",
      "observationId",
      "toolCallId",
      "sourceSnapshotId",
      "rootIndex",
      "relativePath",
      "startLine",
      "endLine",
      "excerptHash",
      "recordedAt",
    ]) ||
    evidence.kind !== "source_fact" ||
    evidence.evidenceId.trim() === "" ||
    evidence.recordedAt !== occurredAt ||
    !isIsoUtc(evidence.recordedAt) ||
    evidenceRecords.some((prior) => prior.evidenceId === evidence.evidenceId) ||
    evidenceRecords.some(
      (prior) => prior.observationId === evidence.observationId,
    )
  ) {
    throw new IllegalRunEventError("Evidence Record 公共字段无效");
  }

  const observation = observations.find(
    (candidate) => candidate.observationId === evidence.observationId,
  );
  if (
    observation?.status !== "succeeded" ||
    evidence.toolCallId !== observation.toolCallId ||
    evidence.sourceSnapshotId !== observation.sourceSnapshot.snapshotId ||
    evidence.rootIndex !== observation.rootIndex ||
    evidence.relativePath !== observation.relativePath ||
    evidence.startLine !== observation.startLine ||
    evidence.endLine !== observation.endLine ||
    evidence.excerptHash !== observation.excerptHash
  ) {
    // Evidence 不重复摘录正文；它把能由成功 observation 重算的 identity/range/hash
    // 冻结成引用边界，回放时必须逐字段回指，不能接受模型或调用方拼出的近似引用。
    throw new IllegalRunEventError("Evidence Record 未精确绑定成功来源 observation");
  }
}

function validateClaim(
  evidenceRecords: readonly EvidenceRecord[],
  claims: readonly Claim[],
  claim: Claim,
  occurredAt: string,
): void {
  if (
    !hasExactKeys(claim, [
      "claimId",
      "kind",
      "text",
      "evidenceIds",
      "recordedAt",
    ]) ||
    claim.claimId.trim() === "" ||
    claim.kind !== "source_fact" ||
    claim.text.trim() === "" ||
    hasPreRenderedCitationToken(claim.text) ||
    claim.recordedAt !== occurredAt ||
    !isIsoUtc(claim.recordedAt) ||
    claim.evidenceIds.length === 0 ||
    !claim.evidenceIds.every((evidenceId) => evidenceId.trim() !== "") ||
    new Set(claim.evidenceIds).size !== claim.evidenceIds.length ||
    claims.some((prior) => prior.claimId === claim.claimId) ||
    !claim.evidenceIds.every((evidenceId) =>
      evidenceRecords.some((evidence) => evidence.evidenceId === evidenceId),
    )
  ) {
    throw new IllegalRunEventError("Claim 必须精确引用已有 Evidence Record");
  }
}

function validateLearningArtifactDraft(
  projection: RunProjection,
  payload: LearningArtifactDraftProposedPayload,
  occurredAt: string,
): void {
  if (
    projection.state.type !== "researching" &&
    projection.state.type !== "research_complete"
  ) {
    throw new IllegalRunEventError("Learning Artifact draft 必须来自 researching Run");
  }
  const researching = projection.state;
  const { draftArtifact, proposal, publicationTarget, publicationBinding } =
    payload;
  if (
    !hasExactKeys(draftArtifact, [
      "artifactId",
      "sha256",
      "mediaType",
      "byteLength",
      "relativePath",
    ]) ||
    !artifactReferenceHasMatchingContentIdentity(draftArtifact) ||
    draftArtifact.mediaType !== "text/markdown; charset=utf-8" ||
    !Number.isSafeInteger(draftArtifact.byteLength) ||
    draftArtifact.byteLength <= 0 ||
    !hasExactKeys(proposal, ["title", "summary", "claimIds"]) ||
    proposal.title.trim() === "" ||
    proposal.summary.trim() === "" ||
    hasPreRenderedCitationToken(proposal.title) ||
    hasPreRenderedCitationToken(proposal.summary) ||
    proposal.claimIds.length === 0 ||
    new Set(proposal.claimIds).size !== proposal.claimIds.length ||
    !proposal.claimIds.every((claimId) => claimId.trim() !== "") ||
    !hasExactPublicationTargetShape(publicationTarget) ||
    !hasExactKeys(publicationBinding, [
      "draftHash",
      "outputRootCanonicalPath",
      "outputRootDevice",
      "outputRootInode",
      "targetCanonicalPath",
      "parentDevice",
      "parentInode",
      "bindingHash",
    ])
  ) {
    throw new IllegalRunEventError("Learning Artifact draft 公共字段无效");
  }

  let markdown: string;
  try {
    assertEvidenceGateBudget({
      modelTurnsUsed: 2 + researching.modelTurns.length,
      toolCallsUsed: countLogicalToolCalls(
        researching.sourceReadObservations,
        researching.researchToolObservations,
      ),
      sourceReadObservations: researching.sourceReadObservations,
      runBudget: projection.runBudget,
      wallTimeStartedAt:
        researching.researchStartedAt ?? projection.createdAt,
      wallTimeEndedAt:
        researching.type === "research_complete"
          ? researching.completion.completedAt
          : occurredAt,
    });
    markdown = renderLearningArtifact(
      proposal,
      evaluateEvidenceGate(
        proposal,
        researching.claims,
        researching.evidenceRecords,
      ),
    );
  } catch (error) {
    if (
      error instanceof EvidenceGateError ||
      error instanceof PreRenderedCitationTokenError
    ) {
      throw new IllegalRunEventError("Learning Artifact draft 未通过 Evidence Gate");
    }
    throw error;
  }
  const expectedBinding = createPublicationApprovalBinding({
    draftHash: draftArtifact.sha256,
    publicationTarget,
  });
  if (
    hashUtf8Text(markdown) !== draftArtifact.sha256 ||
    Buffer.byteLength(markdown, "utf8") !== draftArtifact.byteLength ||
    !publicationBindingsEqual(expectedBinding, publicationBinding) ||
    publicationBinding.draftHash !== draftArtifact.sha256
  ) {
    // draft artifact 不只靠 CAS identity 可信：reducer 对同一 Proposal/Evidence
    // 重新渲染，确保模型无法把未验证 citation 或另一份 Markdown 偷换进审批。
    throw new IllegalRunEventError("Learning Artifact draft 与 Evidence 或审批绑定不一致");
  }
  if (!isIsoUtc(occurredAt)) {
    throw new IllegalRunEventError("Learning Artifact draft 时间无效");
  }
}

function validatePublicationApprovalReceipt(
  draftArtifact: ArtifactReference,
  publicationTarget: PublicationTarget,
  publicationBinding: PublicationApprovalBinding,
  receipt: PublicationApprovalReceipt,
  occurredAt: string,
): void {
  const expectedBinding = createPublicationApprovalBinding({
    draftHash: draftArtifact.sha256,
    publicationTarget,
  });
  if (
    !hasExactKeys(receipt, [
      "approvalId",
      "kind",
      "approvedBy",
      "approvedAt",
      "draftHash",
      "outputRootCanonicalPath",
      "outputRootDevice",
      "outputRootInode",
      "targetCanonicalPath",
      "parentDevice",
      "parentInode",
      "bindingHash",
    ]) ||
    receipt.kind !== "publication" ||
    receipt.approvedBy !== "user-command" ||
    receipt.approvalId.trim() === "" ||
    receipt.approvedAt !== occurredAt ||
    !isIsoUtc(receipt.approvedAt) ||
    !publicationBindingsEqual(expectedBinding, publicationBinding) ||
    !publicationBindingsEqual(expectedBinding, receipt)
  ) {
    throw new IllegalRunEventError("publication approval Receipt 与等待边界不一致");
  }
}

function validatePublishedLearningArtifact(
  draftArtifact: ArtifactReference,
  publicationTarget: PublicationTarget,
  learningArtifact: PublishedLearningArtifact,
  occurredAt: string,
): void {
  if (
    !hasExactKeys(learningArtifact, [
      "targetCanonicalPath",
      "sha256",
      "publishedAt",
    ]) ||
    learningArtifact.targetCanonicalPath !== publicationTarget.targetCanonicalPath ||
    learningArtifact.sha256 !== draftArtifact.sha256 ||
    learningArtifact.publishedAt !== occurredAt ||
    !isIsoUtc(learningArtifact.publishedAt)
  ) {
    throw new IllegalRunEventError("已发布 Learning Artifact 与批准 draft 不一致");
  }
}

function hasExactPublicationTargetShape(target: PublicationTarget): boolean {
  return (
    hasExactKeys(target, [
      "outputRootCanonicalPath",
      "outputRootDevice",
      "outputRootInode",
      "targetCanonicalPath",
      "parentDevice",
      "parentInode",
    ]) &&
    isAbsolute(target.outputRootCanonicalPath) &&
    /^\d+$/.test(target.outputRootDevice) &&
    /^\d+$/.test(target.outputRootInode) &&
    isAbsolute(target.targetCanonicalPath) &&
    /^\d+$/.test(target.parentDevice) &&
    /^\d+$/.test(target.parentInode)
  );
}

function sourceBytesFromObservations(
  observations: readonly SourceReadObservation[],
): number {
  return observations.reduce(
    (total, observation) =>
      total + (observation.status === "succeeded" ? observation.byteLength : 0),
    0,
  );
}

function hasExactSucceededShape(
  observation: SourceReadObservation,
): boolean {
  return hasExactKeys(observation, [
    "observationId",
    "toolCallId",
    "toolName",
    "requestHash",
    "observedAt",
    "status",
    "rootIndex",
    "relativePath",
    "startLine",
    "endLine",
    "totalLines",
    "excerpt",
    "excerptHash",
    "sourceSnapshot",
    "byteLength",
  ]);
}

function hasExactNonSuccessShape(
  observation: SourceReadObservation,
): boolean {
  return hasExactKeys(observation, [
    "observationId",
    "toolCallId",
    "toolName",
    "requestHash",
    "observedAt",
    "status",
    "code",
  ]);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isIsoUtc(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function approvalBindingsEqual(
  expected: PlanApprovalBinding,
  actual: PlanApprovalBinding,
): boolean {
  return (
    actual.questionHash === expected.questionHash &&
    actual.planHash === expected.planHash &&
    actual.sourceScopeHash === expected.sourceScopeHash &&
    actual.budgetVersion === expected.budgetVersion &&
    actual.budgetHash === expected.budgetHash &&
    actual.bindingHash === expected.bindingHash
  );
}
