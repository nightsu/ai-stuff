import {
  artifactReferenceHasMatchingContentIdentity,
  createPlanApprovalBinding,
  hashReadSourceRequest,
  hashUtf8Text,
  sourceSnapshotHasMatchingContentIdentity,
} from "./integrity.js";
import {
  sourcePathPolicyDenial,
  sourceRequestDenial,
} from "./source-policy.js";
import type {
  PlanApprovalBinding,
  ResearchRunEvent,
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
    const lineage =
      event.type === "source_read_observed"
        ? {
            toolCallId: event.payload.observation.toolCallId,
            observationStatus: event.payload.observation.status,
            ...(event.payload.observation.status === "succeeded"
              ? {
                  sourceSnapshotId:
                    event.payload.observation.sourceSnapshot.snapshotId,
                }
              : {}),
          }
        : {};
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

      return {
        ...current,
        state: {
          ...current.state,
          sourceReadObservations: [
            ...current.state.sourceReadObservations,
            observation,
          ],
          sourceBytesRead,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
  }
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
