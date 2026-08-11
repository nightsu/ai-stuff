import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { z } from "zod";

import { createPlanApprovalBinding } from "../domain/integrity.js";
import { buildRunTrace } from "../domain/reducer.js";
import {
  parseResearchPlan,
  parseRunBudget,
  parseSourceScope,
} from "../domain/schemas.js";
import type {
  ResearchRunEvent,
  RunProjection,
  RunTrace,
} from "../domain/types.js";
import { ContentAddressedArtifactStore } from "../infrastructure/content-addressed-artifact-store.js";
import { SqliteRunStore } from "../infrastructure/sqlite-run-store.js";
import type { Clock, IdGenerator, ModelPort } from "./ports.js";

/** 打开一个 headless runtime 所需的基础设施与可控边界。 */
export interface OpenRuntimeOptions {
  /** 私有且应被 git ignore 的 Runtime Home 路径。 */
  readonly runtimeHome: string;
  /** 计划生成使用的 Model Port；inspect 与 trace 不会调用它。 */
  readonly model: ModelPort;
  /** 可选时间边界；生产默认使用系统 UTC 时间。 */
  readonly clock?: Clock;
  /** 可选 identity 边界；生产默认使用 UUID。 */
  readonly ids?: IdGenerator;
}

/** 创建新 Research Run 的应用命令。 */
export interface CreateRunCommand {
  /** 要研究的非空本地技术问题；持久化前会移除首尾空白。 */
  readonly question: string;
  /** 本次 Run 冻结记录的 Source Scope。 */
  readonly sourceScope: unknown;
  /** 本次 Run 冻结记录且不可由模型修改的版本化 Run Budget。 */
  readonly runBudget: unknown;
}

/** 通过 identity 读取当前 Run Projection 的应用命令。 */
export interface InspectRunCommand {
  /** 要读取的 Research Run identity。 */
  readonly runId: string;
}

/** 通过 identity 读取派生 Run Trace 的应用命令。 */
export interface TraceRunCommand {
  /** 要投影为 Trace 的 Research Run identity。 */
  readonly runId: string;
}

/** 从 canonical Journal 显式重建 Projection cache 的应用命令。 */
export interface RebuildRunProjectionCommand {
  /** 要重建缓存投影的 Research Run identity。 */
  readonly runId: string;
}

/** 用用户可见 binding hash 批准一个精确计划版本的应用命令。 */
export interface ApprovePlanCommand {
  /** 当前处于计划审批等待状态的 Research Run identity。 */
  readonly runId: string;
  /** 用户从等待投影提交回来的完整聚合审批摘要。 */
  readonly bindingHash: string;
}

/** 提交的 binding 已不再对应当前等待计划时抛出的安全错误。 */
export class StalePlanApprovalError extends Error {
  public constructor() {
    super("计划审批已过期或与当前等待版本不匹配");
    this.name = "StalePlanApprovalError";
  }
}

/** 非等待状态收到新的计划审批命令时抛出的领域错误。 */
export class IllegalPlanApprovalStateError extends Error {
  public constructor(state: RunProjection["state"]["type"]) {
    super(`当前 ${state} 状态不能接受新的计划审批`);
    this.name = "IllegalPlanApprovalStateError";
  }
}

const createRunCommandSchema = z.object({
  question: z.string().trim().min(1),
  sourceScope: z.unknown(),
  runBudget: z.unknown(),
});

const runIdentityCommandSchema = z.object({
  runId: z.string().trim().min(1),
});

const approvePlanCommandSchema = z
  .object({
    runId: z.string().trim().min(1),
    bindingHash: z.string(),
  })
  .strict();

const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

const uuidGenerator: IdGenerator = {
  nextRunId: () => `run-${randomUUID()}`,
  nextEventId: () => `event-${randomUUID()}`,
  nextApprovalId: () => `approval-${randomUUID()}`,
};

/** CLI 与未来 UI 共同依赖的 command-oriented application seam。 */
export class ResearchAgentRuntime {
  /** 为事件与 artifact 提供可测试时间的边界。 */
  readonly #clock: Clock;
  /** 为 Run 与事件提供可测试 identity 的边界。 */
  readonly #ids: IdGenerator;
  /** 生成研究计划且不泄漏 provider SDK 类型的模型边界。 */
  readonly #model: ModelPort;
  /** 持久化大 payload、只向 Journal 返回内容引用的 artifact 组件。 */
  readonly #artifacts: ContentAddressedArtifactStore;
  /** 持有 canonical Journal 与 derived Projection cache 的 SQLite 组件。 */
  readonly #store: SqliteRunStore;

  private constructor(options: OpenRuntimeOptions) {
    const runtimeHome = resolve(options.runtimeHome);
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? uuidGenerator;
    this.#model = options.model;
    this.#artifacts = new ContentAddressedArtifactStore(runtimeHome);
    this.#store = new SqliteRunStore(runtimeHome);
  }

  public static open(options: OpenRuntimeOptions): ResearchAgentRuntime {
    return new ResearchAgentRuntime(options);
  }

  public async createRun(command: CreateRunCommand): Promise<RunProjection> {
    const parsed = createRunCommandSchema.parse(command);
    const sourceScope = parseSourceScope(parsed.sourceScope);
    const runBudget = parseRunBudget(parsed.runBudget);
    const runId = this.#ids.nextRunId();
    const createdAt = this.#clock.now();

    const initialEvents: ResearchRunEvent[] = [
      {
        eventId: this.#ids.nextEventId(),
        runId,
        sequence: 1,
        type: "run_created",
        occurredAt: createdAt,
        payload: { question: parsed.question, sourceScope, runBudget },
      },
      {
        eventId: this.#ids.nextEventId(),
        runId,
        sequence: 2,
        type: "planning_started",
        occurredAt: createdAt,
        payload: {},
      },
    ];
    this.#store.appendEvents(runId, 0, initialEvents);

    // Model 调用位于数据库短事务之外，避免用 SQLite 写锁包住不可预测的外部延迟。
    // 若调用失败，Run 仍可从 planning 状态被 inspect；显式失败语义将在 ticket #7 加入。
    const plan = parseResearchPlan(
      await this.#model.proposePlan({
        runId,
        question: parsed.question,
        sourceScope,
      }),
    );
    const proposedAt = this.#clock.now();
    const artifact = await this.#artifacts.putJson(
      plan,
      "application/json",
      proposedAt,
    );
    const approvalBinding = createPlanApprovalBinding({
      question: parsed.question,
      planHash: artifact.sha256,
      sourceScope,
      runBudget,
    });
    const planProposed: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: 3,
      type: "plan_proposed",
      occurredAt: proposedAt,
      payload: { planArtifact: artifact, approvalBinding },
    };

    return this.#store.appendEvents(runId, 2, [planProposed], [artifact]);
  }

  public async inspectRun(command: InspectRunCommand): Promise<RunProjection> {
    const { runId } = runIdentityCommandSchema.parse(command);
    return this.#store.readProjection(runId);
  }

  public async approvePlan(
    command: ApprovePlanCommand,
  ): Promise<RunProjection> {
    const { runId, bindingHash } = approvePlanCommandSchema.parse(command);
    const current = this.#store.readProjection(runId);

    // 幂等判断必须发生在生成 Approval Receipt 或 event identity 之前；否则同一
    // 用户命令的安全重试会消耗新 identity，并可能制造第二个授权事实。
    if (
      current.state.type === "researching" &&
      current.state.approvalReceipt.bindingHash === bindingHash
    ) {
      return current;
    }
    if (current.state.type !== "waiting_plan_approval") {
      throw new IllegalPlanApprovalStateError(current.state.type);
    }

    // stale hash 一律 fail closed；错误不回显期望值、提交值、计划内容或 Source
    // Scope，避免把审批边界当作诊断 payload 泄露出去。
    if (bindingHash !== current.state.approvalBinding.bindingHash) {
      throw new StalePlanApprovalError();
    }

    const approvedAt = this.#clock.now();
    const approvalReceipt = {
      approvalId: this.#ids.nextApprovalId(),
      kind: "plan",
      approvedBy: "user-command",
      approvedAt,
      ...current.state.approvalBinding,
    } as const;
    const event: ResearchRunEvent = {
      eventId: this.#ids.nextEventId(),
      runId,
      sequence: current.lastEventSequence + 1,
      type: "plan_approved",
      occurredAt: approvedAt,
      payload: { approvalReceipt },
    };

    // Approval 是独立用户命令，不接受模型输出、Research Tool 参数、环境变量或
    // 调用方自造 Receipt；这里使用读取时的 last sequence 保留乐观并发语义。
    return this.#store.appendEvents(
      runId,
      current.lastEventSequence,
      [event],
    );
  }

  public async traceRun(command: TraceRunCommand): Promise<RunTrace> {
    const { runId } = runIdentityCommandSchema.parse(command);
    return buildRunTrace(this.#store.readEvents(runId));
  }

  public async rebuildRunProjection(
    command: RebuildRunProjectionCommand,
  ): Promise<RunProjection> {
    const { runId } = runIdentityCommandSchema.parse(command);
    return this.#store.rebuildProjection(runId);
  }

  public close(): void {
    this.#store.close();
  }
}
