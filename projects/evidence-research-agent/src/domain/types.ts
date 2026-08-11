/** 已在 Run 创建边界解析并绑定的本地 Source Root identity。 */
export interface SourceRootIdentity {
  /** 审批时由 `realpath` 得到且后续不得重新解释的 canonical 绝对目录。 */
  readonly canonicalPath: string;
  /** 审批时目录设备号的无损十进制字符串，避免大整数经过 JS number 丢失。 */
  readonly device: string;
  /** 审批时目录 inode 的无损十进制字符串，避免大整数经过 JS number 丢失。 */
  readonly inode: string;
}

/** 调用方提交、尚未取得文件系统 identity 的 Source Scope 请求。 */
export interface RequestedSourceScope {
  /** 调用方请求批准的绝对目录；不能提交 canonical identity 字段。 */
  readonly roots: readonly string[];
  /** 相对根目录匹配的排除模式；搜索与读取端口必须共同执行。 */
  readonly exclusions: readonly string[];
  /** 请求允许的小写文件扩展名，统一包含前导点，例如 `.md`。 */
  readonly allowedExtensions: readonly string[];
  /** 单个源文件请求的最大字节数，单位为 byte。 */
  readonly maxFileBytes: number;
  /** 一个 Run 请求的累计最大源字节数，单位为 byte。 */
  readonly maxTotalBytes: number;
}

/** 一个 Research Run 已批准且绑定 canonical identities 的本地文本范围。 */
export interface SourceScope {
  /** 允许访问且已经绑定 canonical path、device 与 inode 的目录根。 */
  readonly roots: readonly SourceRootIdentity[];
  /** 相对根目录匹配的排除模式；后续搜索与读取端口必须共同执行。 */
  readonly exclusions: readonly string[];
  /** 允许读取的文件扩展名，统一包含前导点，例如 `.md`。 */
  readonly allowedExtensions: readonly string[];
  /** 单个源文件允许读取的最大字节数，单位为 byte。 */
  readonly maxFileBytes: number;
  /** 一个 Run 在该范围内允许读取的累计最大字节数，单位为 byte。 */
  readonly maxTotalBytes: number;
}

/** 一个 Research Run 经用户批准后不可由模型抬高的多维限制。 */
export interface RunBudget {
  /** 预算策略的非空稳定版本，变更任一限制时必须产生新版本。 */
  readonly version: string;
  /** Research Loop 允许完成的最大 Model Turn 数。 */
  readonly maxModelTurns: number;
  /** Research Loop 允许提交的最大 Research Tool 调用数。 */
  readonly maxToolCalls: number;
  /** 一个 Run 允许纳入证据的最大不同 Source Snapshot 数。 */
  readonly maxDistinctSources: number;
  /** 一个 Run 允许读取并计入预算的累计源内容字节数。 */
  readonly maxSourceBytes: number;
  /** 一个 Run 从开始到预算暂停允许消耗的最大墙钟时间，单位为毫秒。 */
  readonly maxWallTimeMs: number;
}

/** 用户批准计划时必须逐字段匹配的内容寻址边界。 */
export interface PlanApprovalBinding {
  /** 规范 JSON 编码后的精确技术问题 SHA-256 摘要。 */
  readonly questionHash: string;
  /** 已持久化计划 artifact 精确字节内容的 SHA-256 摘要。 */
  readonly planHash: string;
  /** 规范 JSON 编码后的完整 Source Scope SHA-256 摘要。 */
  readonly sourceScopeHash: string;
  /** 绑定时 Run Budget 的稳定策略版本。 */
  readonly budgetVersion: string;
  /** 规范 JSON 编码后的完整 Run Budget SHA-256 摘要。 */
  readonly budgetHash: string;
  /** 对前述五个组成字段再次规范哈希得到的聚合审批摘要。 */
  readonly bindingHash: string;
}

/** 由独立用户命令签发、可随 Run Journal 精确回放的计划审批凭据。 */
export interface PlanApprovalReceipt {
  /** 本次审批事实的跨进程稳定 identity，不与事件 identity 混用。 */
  readonly approvalId: string;
  /** 审批种类；计划审批不得被解释为发布或其他授权。 */
  readonly kind: "plan";
  /** 唯一允许的审批主体来源，明确排除模型与 Research Tool。 */
  readonly approvedBy: "user-command";
  /** 用户命令被接受的 ISO 8601 UTC 时间。 */
  readonly approvedAt: string;
  /** 被用户提交并与当前等待状态精确匹配的聚合审批摘要。 */
  readonly bindingHash: string;
  /** Receipt 所授权原始技术问题的规范 JSON SHA-256 摘要。 */
  readonly questionHash: string;
  /** Receipt 所授权不可变计划 artifact 的内容 SHA-256 摘要。 */
  readonly planHash: string;
  /** Receipt 所授权完整 Source Scope 的规范 JSON SHA-256 摘要。 */
  readonly sourceScopeHash: string;
  /** Receipt 所授权 Run Budget 的稳定策略版本。 */
  readonly budgetVersion: string;
  /** Receipt 所授权完整 Run Budget 的规范 JSON SHA-256 摘要。 */
  readonly budgetHash: string;
}

/** 研究计划中的一个有序步骤。 */
export interface PlanStep {
  /** 在当前计划版本内稳定且唯一的步骤标识。 */
  readonly id: string;
  /** 面向用户的步骤目的，而不是模型内部提示词。 */
  readonly description: string;
}

/** 等待用户批准的不可变研究计划内容。 */
export interface ResearchPlan {
  /** 计划的简短标题，用于 inspect 与后续批准界面。 */
  readonly title: string;
  /** 本次研究要回答或澄清的可验证目标列表。 */
  readonly objectives: readonly string[];
  /** 按执行意图排序的计划步骤。 */
  readonly steps: readonly PlanStep[];
}

/** 内容寻址 Artifact Store 中一个不可变对象的稳定引用。 */
export interface ArtifactReference {
  /** 由内容摘要派生的 artifact identity，格式为 `sha256:<hex>`。 */
  readonly artifactId: string;
  /** artifact 内容的 64 位小写十六进制 SHA-256 摘要。 */
  readonly sha256: string;
  /** artifact 的 MIME 类型；计划使用 `application/json`。 */
  readonly mediaType: string;
  /** 持久化 UTF-8 内容的精确字节数，单位为 byte。 */
  readonly byteLength: number;
  /** 相对于 Runtime Home 的私有路径，不得被当作发布路径。 */
  readonly relativePath: string;
}

/** 已创建、尚未开始规划的 Run 状态。 */
export interface CreatedRunState {
  /** 判别字段；只允许由 `run_created` 事件产生。 */
  readonly type: "created";
}

/** Model Port 正在为 Run 生成计划的持久状态。 */
export interface PlanningRunState {
  /** 判别字段；只允许由 `planning_started` 事件产生。 */
  readonly type: "planning";
  /** 规划开始时间，ISO 8601 UTC 字符串。 */
  readonly startedAt: string;
}

/** 计划已生成且必须等待精确版本批准的暂停状态。 */
export interface WaitingPlanApprovalRunState {
  /** 判别字段；该状态不可自行推进到研究循环。 */
  readonly type: "waiting_plan_approval";
  /** 被提交给用户审批的不可变计划 artifact。 */
  readonly planArtifact: ArtifactReference;
  /** 把计划与原始问题、Source Scope 和预算精确版本绑定的摘要集合。 */
  readonly approvalBinding: PlanApprovalBinding;
  /** 计划被正式写入 Run Journal 的时间，ISO 8601 UTC 字符串。 */
  readonly proposedAt: string;
}

/** 精确计划已获用户批准、可以进入 Research Loop 的 Run 状态。 */
export interface ResearchingRunState {
  /** 判别字段；只允许由合法 `plan_approved` 事件产生。 */
  readonly type: "researching";
  /** 已获批准且继续保持内容寻址 identity 的计划 artifact。 */
  readonly planArtifact: ArtifactReference;
  /** 对该计划、问题、Source Scope 与预算精确版本的完整审批凭据。 */
  readonly approvalReceipt: PlanApprovalReceipt;
}

/** 当前 planning slice 允许出现的最小 Run 状态联合。 */
export type ResearchRunState =
  | CreatedRunState
  | PlanningRunState
  | WaitingPlanApprovalRunState
  | ResearchingRunState;

/** 从 Run Journal 确定性派生的当前 Run 视图。 */
export interface RunProjection {
  /** 跨进程稳定的 Research Run identity。 */
  readonly runId: string;
  /** 用户发起 Run 时提交并去除首尾空白后的技术问题。 */
  readonly question: string;
  /** 创建 Run 时冻结的 Source Scope 值。 */
  readonly sourceScope: SourceScope;
  /** 创建 Run 时冻结且只能通过新批准版本改变的 Run Budget。 */
  readonly runBudget: RunBudget;
  /** 当前合法状态；不得由独立布尔标记拼装。 */
  readonly state: ResearchRunState;
  /** 已应用的最后一个连续事件序号，从 1 开始。 */
  readonly lastEventSequence: number;
  /** Run 创建时间，ISO 8601 UTC 字符串。 */
  readonly createdAt: string;
  /** 当前投影最后一次语义变化时间，ISO 8601 UTC 字符串。 */
  readonly updatedAt: string;
}

/** `run_created` 事件携带的创建事实。 */
export interface RunCreatedPayload {
  /** 创建时去除首尾空白后的技术问题，后续事件不得覆写。 */
  readonly question: string;
  /** 创建时冻结的 Source Scope，后续扩权必须产生新版本。 */
  readonly sourceScope: SourceScope;
  /** 创建时冻结的多维预算；模型输出不得选择或提高这些限制。 */
  readonly runBudget: RunBudget;
}

/** `plan_proposed` 事件携带的计划事实。 */
export interface PlanProposedPayload {
  /** 已先持久化并可按摘要验证的计划 artifact 引用。 */
  readonly planArtifact: ArtifactReference;
  /** 该计划进入等待审批状态时计算并持久化的精确边界。 */
  readonly approvalBinding: PlanApprovalBinding;
}

/** `plan_approved` 事件携带且足以独立审计的用户审批事实。 */
export interface PlanApprovedPayload {
  /** 绑定全部组成摘要、审批主体、identity 与时间的完整 Receipt。 */
  readonly approvalReceipt: PlanApprovalReceipt;
}

/** 一个有顺序、可回放的 Run Journal 语义事件。 */
export interface RunEvent<Type extends string, Payload> {
  /** 跨重试稳定的事件 identity。 */
  readonly eventId: string;
  /** 事件所属的 Research Run identity。 */
  readonly runId: string;
  /** Run 内严格连续且从 1 开始的顺序号。 */
  readonly sequence: number;
  /** 语义事件类型，而不是实现日志级别。 */
  readonly type: Type;
  /** 事件提交意图发生的时间，ISO 8601 UTC 字符串。 */
  readonly occurredAt: string;
  /** 只包含重建状态所需事实的类型化载荷。 */
  readonly payload: Payload;
}

/** 当前 planning slice 的完整 Run Journal 事件联合。 */
export type ResearchRunEvent =
  | RunEvent<"run_created", RunCreatedPayload>
  | RunEvent<"planning_started", Record<never, never>>
  | RunEvent<"plan_proposed", PlanProposedPayload>
  | RunEvent<"plan_approved", PlanApprovedPayload>;

/** 已写入 Artifact Store、等待登记到 SQLite 的元数据。 */
export interface PersistedArtifact extends ArtifactReference {
  /** artifact 首次写入 Runtime Home 的时间，ISO 8601 UTC 字符串。 */
  readonly createdAt: string;
}

/** Run Trace 中单个事件及其应用后的可解释状态。 */
export interface RunTraceEvent {
  /** 原始 Run Journal 事件的连续序号。 */
  readonly sequence: number;
  /** 原始 Run Journal 事件的稳定 identity。 */
  readonly eventId: string;
  /** 原始语义事件类型。 */
  readonly type: ResearchRunEvent["type"];
  /** 原始事件时间，ISO 8601 UTC 字符串。 */
  readonly occurredAt: string;
  /** reducer 应用该事件后得到的状态判别值。 */
  readonly stateAfter: ResearchRunState["type"];
}

/** 面向人或机器读取、但不作为 canonical history 的 Run Trace。 */
export interface RunTrace {
  /** Trace 对应的 Research Run identity。 */
  readonly runId: string;
  /** 回放全部事件后得到的当前状态。 */
  readonly finalState: ResearchRunState["type"];
  /** 按 Journal 顺序投影出的精简事件列表。 */
  readonly events: readonly RunTraceEvent[];
}
