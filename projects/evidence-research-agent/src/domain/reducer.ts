import {
  artifactReferenceHasMatchingContentIdentity,
  createPlanApprovalBinding,
} from "./integrity.js";
import type {
  PlanApprovalBinding,
  ResearchRunEvent,
  RunProjection,
  RunTrace,
  RunTraceEvent,
} from "./types.js";

export class IllegalRunEventError extends Error {}

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
    traceEvents.push({
      sequence: event.sequence,
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      stateAfter: projection.state.type,
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
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
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
