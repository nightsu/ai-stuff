import type {
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
      return {
        ...current,
        state: {
          type: "waiting_plan_approval",
          planArtifact: event.payload.planArtifact,
          proposedAt: event.occurredAt,
        },
        lastEventSequence: event.sequence,
        updatedAt: event.occurredAt,
      };
    }
  }
}
