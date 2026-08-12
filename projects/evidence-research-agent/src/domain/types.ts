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

/** 一次 `read_source` Research Tool 的完整结构化请求。 */
export interface ReadSourceRequest {
  /** 只选择已批准 `SourceScope.roots` 的零基索引。 */
  readonly rootIndex: number;
  /** 相对于所选批准根的 POSIX 文件路径。 */
  readonly relativePath: string;
  /** 请求摘录的首行，使用 1-based inclusive 语义。 */
  readonly startLine: number;
  /** 请求摘录的末行，使用 1-based inclusive 语义。 */
  readonly endLine: number;
}

/** Source Scope 策略拒绝读取时公开的稳定代码。 */
export type SourceAccessDenialCode =
  | "invalid_root"
  | "invalid_path"
  | "invalid_line_range"
  | "line_range_out_of_bounds"
  | "path_escape"
  | "symlink_escape"
  | "symlink_path"
  | "excluded_path"
  | "secret_path"
  | "extension_not_allowed"
  | "binary_file"
  | "file_too_large"
  | "source_budget_exceeded"
  | "line_range_too_large";

/** 预期文件系统失败被归一化后公开的稳定代码。 */
export type SourceAccessFailureCode =
  | "root_changed"
  | "path_changed_during_read"
  | "source_changed_during_read"
  | "source_not_found"
  | "source_not_file"
  | "source_io_error";

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

/** Model Port 返回、但仍须由 Harness 调度和校验的单个 Research Tool intent。 */
export interface ResearchToolIntent {
  /** Model Turn 内稳定且非空的 intent identity，用于 observation 回填。 */
  readonly intentId: string;
  /** 五个模型可见 Research Tools 之一；治理与 publication 不在此联合中。 */
  readonly name:
    | "search_sources"
    | "read_source"
    | "record_evidence"
    | "propose_claim"
    | "complete_research";
  /** 模型原样提出的 JSON-like 参数；Harness 必须按具体工具 schema 再校验。 */
  readonly input: unknown;
}

/** 一次 provider-neutral、完整提交后才可进入 Run Journal 的 Model Turn。 */
export interface ModelTurn {
  /** 由 Harness 从承载该 turn 的 Journal event identity 派生的稳定 identity。 */
  readonly turnId: string;
  /** 模型本轮可见推理摘要；不是 canonical 状态或完整 messages history。 */
  readonly text: string;
  /** 模型声明仍待关闭的 evidence gaps；下一轮 Model View 会固定保留。 */
  readonly evidenceGaps: readonly string[];
  /** 完整 generation 的 provider-neutral 结束原因。 */
  readonly finishReason: "tool_calls" | "stop";
  /** 由 Harness 逐项调度的有序 Research Tool intents。 */
  readonly toolIntents: readonly ResearchToolIntent[];
  /** 完整 Model Turn 被提交为 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly completedAt: string;
}

/** `search_sources` 返回给下一轮 Model View 的一个受 Source Scope 约束的命中。 */
export interface SourceSearchMatch {
  /** 命中所属批准 Source Root 的零基索引。 */
  readonly rootIndex: number;
  /** 相对于批准根且通过共享路径策略的 canonical POSIX 路径。 */
  readonly relativePath: string;
  /** 命中行的 1-based 行号。 */
  readonly lineNumber: number;
  /** `rg` 返回的单行 UTF-8 文本，最多保留固定长度。 */
  readonly lineText: string;
}

/** Journal 为成功 search observation 保存的轻量 Artifact 引用。 */
export interface PersistedSourceSearchOutput {
  /** 私有 Artifact Store 中保存完整有界命中列表的稳定引用。 */
  readonly searchResultArtifact: ArtifactReference;
  /** artifact 内命中数量，供 Projection 与 Trace 无需读取正文即可解释结果。 */
  readonly matchCount: number;
}

/** Research Tool 成功时可暴露给下一轮模型的最小结构化结果。 */
export type ResearchToolOutput =
  | PersistedSourceSearchOutput
  | {
      /** `read_source` 已 durable 写入的 Source Read Observation identity。 */
      readonly sourceObservationId: string;
    }
  | {
      /** `record_evidence` 新创建且可被后续 Claim 引用的 identity。 */
      readonly evidenceId: string;
    }
  | {
      /** `propose_claim` 新创建且可被 publication proposal 选择的 identity。 */
      readonly claimId: string;
    }
  | {
      /** `complete_research` 明确保留的未解决问题。 */
      readonly unresolvedQuestions: readonly string[];
    };

/** Model View 为最近搜索 observation 按需加载的有界结构化结果。 */
export type ModelViewResearchToolOutput =
  | {
      /** `search_sources` 按批准 root 与原始输出顺序返回的有界命中。 */
      readonly matches: readonly SourceSearchMatch[];
    }
  | Exclude<ResearchToolOutput, PersistedSourceSearchOutput>;

/** Harness 对一个模型 intent 的安全、可回放 observation。 */
export interface ResearchToolObservation {
  /** observation 的跨进程稳定 identity，不与 event 或 intent identity 混用。 */
  readonly observationId: string;
  /** Harness 分配的逻辑 Research Tool call identity，用于预算和 Trace。 */
  readonly toolCallId: string;
  /** 被执行或拒绝的模型 intent identity。 */
  readonly intentId: string;
  /** 被 Harness 识别的五个模型可见工具名。 */
  readonly toolName: ResearchToolIntent["name"];
  /** 结果分类；schema 错误、denial 与普通失败不会伪装成成功。 */
  readonly status: "succeeded" | "invalid" | "denied" | "failed";
  /** 面向模型和 Trace 的稳定代码；成功 observation 不携带此字段。 */
  readonly code?: string | undefined;
  /** 不含绝对路径、秘密或原始异常的紧凑确定性摘要。 */
  readonly summary: string;
  /** 成功时的最小 typed output；失败或拒绝时省略。 */
  readonly output?: ResearchToolOutput | undefined;
  /** observation 进入 Run Journal 的 ISO 8601 UTC 时间。 */
  readonly observedAt: string;
}

/** Model View 中的 observation；search artifact 仅在最近窗口内按需展开。 */
export interface ModelViewResearchToolObservation
  extends Omit<ResearchToolObservation, "output"> {
  /** 最近搜索结果可展开为 matches，其他工具保持原有最小 typed output。 */
  readonly output?: ModelViewResearchToolOutput | undefined;
}

/** 每轮 generation 前由 canonical facts 确定性重建的模型可见预算余额。 */
export interface RemainingRunBudget {
  /** 尚可完成的 Model Turn 数；计划 generation 已由 Harness 计入。 */
  readonly modelTurns: number;
  /** 尚可提交的逻辑 Research Tool call 数。 */
  readonly toolCalls: number;
  /** 尚可首次纳入的不同 Source Snapshot 数。 */
  readonly distinctSources: number;
  /** 尚可读取并冻结的源字节数，单位为 byte。 */
  readonly sourceBytes: number;
  /** Research Loop 尚可消耗的墙钟时间，单位为毫秒。 */
  readonly wallTimeMs: number;
}

/** 不等同于 Run Journal/messages、供一次 Research Loop generation 使用的派生视图。 */
export interface ModelView {
  /** 当前 Research Run identity。 */
  readonly runId: string;
  /** 用户批准边界内的原始技术问题。 */
  readonly question: string;
  /** Harness 固定拥有且每轮重新注入的 Research Loop 规则。 */
  readonly fixedRules: readonly string[];
  /** 从已批准 plan artifact 验证读取的精确研究计划。 */
  readonly approvedPlan: ResearchPlan;
  /** 当前 durable plan approval 的聚合 binding hash。 */
  readonly approvalBindingHash: string;
  /** 已批准且模型不能提高的 Run Budget 版本。 */
  readonly budgetVersion: string;
  /** 从 canonical usage facts 计算的五维剩余预算。 */
  readonly remainingBudget: RemainingRunBudget;
  /** 上一完整 Model Turn 声明、仍需模型处理的 evidence gaps。 */
  readonly evidenceGaps: readonly string[];
  /** 尚未获得 observation 的 durable tool intents；恢复时必须优先处理。 */
  readonly pendingIntents: readonly ResearchToolIntent[];
  /** 与当前 Claims/gaps 相关、且带精确摘录的有界 Evidence 视图。 */
  readonly relevantEvidence: readonly ModelViewEvidence[];
  /** 最近若干工具 observation；旧结果通过稳定 identities 保留而非完整 Journal。 */
  readonly recentObservations: readonly ModelViewResearchToolObservation[];
  /** 最近一次非空用户 steering；裁剪时不得删除。 */
  readonly latestSteering?: string | undefined;
}

/** Model View 中从 durable Evidence 与成功读取 observation 派生的可见证据。 */
export interface ModelViewEvidence {
  /** 当前 Run 中稳定的 Evidence identity。 */
  readonly evidenceId: string;
  /** 可追到明确 Source Snapshot 的 canonical 相对路径。 */
  readonly relativePath: string;
  /** Evidence 摘录的 1-based inclusive 首行。 */
  readonly startLine: number;
  /** Evidence 摘录的 1-based inclusive 末行。 */
  readonly endLine: number;
  /** 从成功 observation 重用的精确摘录，不重新读取 live file。 */
  readonly excerpt: string;
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

/** 已完成计划审批后，所有 Evidence/Claim/发布状态共同保留的可回放研究事实。 */
export interface EvidenceBackedRunStateData {
  /** 已获批准且继续保持内容寻址 identity 的计划 artifact。 */
  readonly planArtifact: ArtifactReference;
  /** 对该计划、问题、Source Scope 与预算精确版本的完整审批凭据。 */
  readonly approvalReceipt: PlanApprovalReceipt;
  /** 按 Journal 顺序保留的显式 `read_source` 结果，不包含绝对路径或原始错误。 */
  readonly sourceReadObservations: readonly SourceReadObservation[];
  /** 仅由成功 observation 的完整快照字节数确定性求和得到的累计值。 */
  readonly sourceBytesRead: number;
  /** 按 Journal 顺序记录、且逐项绑定成功来源 observation 的可审计来源事实。 */
  readonly evidenceRecords: readonly EvidenceRecord[];
  /** 按 Journal 顺序记录、并只能引用已有 Evidence Record 的待发布主张。 */
  readonly claims: readonly Claim[];
  /** 按 Journal 顺序保存的完整 Research Loop Model Turns。 */
  readonly modelTurns: readonly ModelTurn[];
  /** 按完成顺序保存的 Research Tool observations。 */
  readonly researchToolObservations: readonly ResearchToolObservation[];
  /** 最近一个 Model Turn 声明的未决 evidence gaps。 */
  readonly evidenceGaps: readonly string[];
  /** 已 durable 提交但尚未得到 observation 的有序 tool intents。 */
  readonly pendingToolIntents: readonly ResearchToolIntent[];
  /** 最近一次进入 Model View 的非空用户 steering。 */
  readonly latestSteering?: string | undefined;
  /** 第一个 Research Loop Model Turn 的 ISO 8601 UTC 时间；审批等待不计入 wall time。 */
  readonly researchStartedAt?: string | undefined;
}

/** 精确计划已获用户批准、可以继续显式收集 Evidence 与 Claim 的 Run 状态。 */
export interface ResearchingRunState extends EvidenceBackedRunStateData {
  /** 判别字段；只允许由合法 `plan_approved` 事件产生。 */
  readonly type: "researching";
}

/** 模型已通过 `complete_research` 显式结束调查、可以进入外层 Gate 的状态。 */
export interface ResearchCompleteRunState extends EvidenceBackedRunStateData {
  /** 判别字段；它不是最终 completed，仍需验证、审批与 publication。 */
  readonly type: "research_complete";
  /** 模型显式保留的未解决问题；空数组表示没有已知未决项。 */
  readonly completion: ResearchCompletion;
}

/** 一个预算维度耗尽后保留精确可恢复研究事实的 Suspended Run。 */
export interface BudgetExhaustedRunState extends EvidenceBackedRunStateData {
  /** 判别字段；该状态不能发布，也不能伪装为研究成功。 */
  readonly type: "budget_exhausted";
  /** 首个阻止继续推进的稳定预算维度。 */
  readonly exhaustedDimension:
    | "model_turns"
    | "tool_calls"
    | "distinct_sources"
    | "source_bytes"
    | "wall_time";
  /** 暂停发生时确定性计算的五维剩余预算。 */
  readonly remainingBudget: RemainingRunBudget;
}

/** 当前 planning slice 允许出现的最小 Run 状态联合。 */
export type ResearchRunState =
  | CreatedRunState
  | PlanningRunState
  | WaitingPlanApprovalRunState
  | ResearchingRunState
  | ResearchCompleteRunState
  | BudgetExhaustedRunState
  | WaitingPublicationApprovalRunState
  | ReadyToPublishRunState
  | CompletedRunState;

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

/** `model_turn_completed` 事件携带的 provider-neutral generation 事实。 */
export interface ModelTurnCompletedPayload {
  /** 只有完整 generation 才能持久化的 Model Turn。 */
  readonly turn: ModelTurn;
  /** Harness 开始本次 generation 前捕获的 ISO 8601 UTC 时间，用于计入模型延迟。 */
  readonly generationStartedAt: string;
  /** 本轮构建 Model View 时采用的最新非空 steering。 */
  readonly latestSteering?: string | undefined;
}

/** `research_tool_observed` 事件携带的 Harness 工具反馈。 */
export interface ResearchToolObservedPayload {
  /** 对一个 durable pending intent 的成功、无效、拒绝或失败 observation。 */
  readonly observation: ResearchToolObservation;
}

/** 模型显式声明研究完成时提交的结构化不确定性。 */
export interface ResearchCompletion {
  /** 仍未解决、必须在最终工件中保持可见的简短问题列表。 */
  readonly unresolvedQuestions: readonly string[];
  /** completion 成为 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly completedAt: string;
}

/** `research_completed` 事件同时关闭 pending completion intent 并记录完成事实。 */
export interface ResearchCompletedPayload {
  /** 显式完成研究时保留的不确定性。 */
  readonly completion: ResearchCompletion;
  /** `complete_research` tool 的成功 observation。 */
  readonly observation: ResearchToolObservation;
}

/** `run_budget_exhausted` 事件记录不可被模型覆盖的暂停原因。 */
export interface RunBudgetExhaustedPayload {
  /** 首个达到硬上限并阻止继续执行的预算维度。 */
  readonly exhaustedDimension: BudgetExhaustedRunState["exhaustedDimension"];
  /** 事件时由 canonical usage facts 计算的剩余预算。 */
  readonly remainingBudget: RemainingRunBudget;
}

/** `source_read_observed` 事件携带的完整、已消毒读取事实。 */
export interface SourceReadObservedPayload {
  /** 成功、策略拒绝或稳定失败中的一个结构化 observation。 */
  readonly observation: SourceReadObservation;
  /** 来自 Research Loop 时，对 durable read intent 的模型可见安全 observation。 */
  readonly researchObservation?: ResearchToolObservation | undefined;
}

/** 一个从成功来源读取事实派生、不可由模型伪造的最小 Evidence Record。 */
export interface EvidenceRecord {
  /** 由 Runtime 从本次 Journal event identity 派生的稳定 Evidence identity。 */
  readonly evidenceId: string;
  /** 当前切片仅允许把明确来源读取登记为可引用的 source fact。 */
  readonly kind: "source_fact";
  /** 该 Evidence 唯一绑定的成功 Source Read Observation identity。 */
  readonly observationId: string;
  /** Observation 内部生成的 Research Tool call identity，用于 Trace lineage。 */
  readonly toolCallId: string;
  /** Observation 冻结的完整私有 Source Snapshot identity。 */
  readonly sourceSnapshotId: string;
  /** Observation 实际命中的已批准 Source Root 零基索引。 */
  readonly rootIndex: number;
  /** Observation 的规范相对 POSIX 路径，不保存绝对来源路径。 */
  readonly relativePath: string;
  /** Evidence 绑定摘录的 1-based inclusive 首行。 */
  readonly startLine: number;
  /** Evidence 绑定摘录的 1-based inclusive 末行。 */
  readonly endLine: number;
  /** Evidence 绑定摘录原始 UTF-8 字节的 SHA-256 摘要。 */
  readonly excerptHash: string;
  /** Evidence 成为 Run Journal 事实的 ISO 8601 UTC 时间。 */
  readonly recordedAt: string;
}

/** 一个只能通过已有 Evidence Record 证明的最小可发布主张。 */
export interface Claim {
  /** 由 Runtime 从本次 Journal event identity 派生的稳定 Claim identity。 */
  readonly claimId: string;
  /** 当前最小切片显式只允许原始来源事实，后续分类须各自拥有独立 Gate 规则。 */
  readonly kind: "source_fact";
  /** 面向 Learning Artifact 的简短主张文本，不能包含渲染后的 citation 字符串。 */
  readonly text: string;
  /** 去重且按调用方明确顺序保存的 Evidence identities。 */
  readonly evidenceIds: readonly string[];
  /** Claim 成为 Run Journal 事实的 ISO 8601 UTC 时间。 */
  readonly recordedAt: string;
}

/** `evidence_recorded` 事件携带的、已从成功 observation 派生的 Evidence 事实。 */
export interface EvidenceRecordedPayload {
  /** 只能由 Runtime 从 canonical Projection 生成的完整 Evidence Record。 */
  readonly evidence: EvidenceRecord;
  /** 来自 Research Loop 时，对 durable Evidence intent 的成功 observation。 */
  readonly researchObservation?: ResearchToolObservation | undefined;
}

/** `claim_recorded` 事件携带的、仅引用既有 Evidence 的 Claim 事实。 */
export interface ClaimRecordedPayload {
  /** 待后续 Evidence Gate 审核的完整 Claim。 */
  readonly claim: Claim;
  /** 来自 Research Loop 时，对 durable Claim intent 的成功 observation。 */
  readonly researchObservation?: ResearchToolObservation | undefined;
}

/** 模型只能选择既有 Claim、不能自造 citation identity 的有界 Markdown 提案。 */
export interface LearningArtifactProposal {
  /** 要渲染为 Markdown 一级标题的简短学习主题。 */
  readonly title: string;
  /** 要渲染在 Claim 列表前的简短学习摘要。 */
  readonly summary: string;
  /** 模型选择的既有 Claim identities；顺序决定 Markdown 的展示顺序。 */
  readonly claimIds: readonly string[];
}

/** 一个经 canonical parent realpath 与 inode 绑定、可被用户批准的 Markdown 目标。 */
export interface PublicationTarget {
  /** 发布目标必须位于其内的 canonical Output Root 路径。 */
  readonly outputRootCanonicalPath: string;
  /** 准备时 Output Root 的设备号，防止 root 被同路径替换后继续发布。 */
  readonly outputRootDevice: string;
  /** 准备时 Output Root 的 inode，防止 root 被同路径替换后继续发布。 */
  readonly outputRootInode: string;
  /** 由批准时 canonical parent directory 与 basename 组成的绝对目标路径。 */
  readonly targetCanonicalPath: string;
  /** 批准时目标父目录设备号的无损十进制字符串。 */
  readonly parentDevice: string;
  /** 批准时目标父目录 inode 的无损十进制字符串。 */
  readonly parentInode: string;
}

/** 用户批准发布前逐字段匹配的 draft 与目标边界。 */
export interface PublicationApprovalBinding {
  /** 私有持久化 Markdown draft 精确 UTF-8 内容的 SHA-256 摘要。 */
  readonly draftHash: string;
  /** 绑定 target 所属的 canonical Output Root，排除 Runtime Home 或任意外部目录。 */
  readonly outputRootCanonicalPath: string;
  /** 绑定 Output Root 的审批时设备号。 */
  readonly outputRootDevice: string;
  /** 绑定 Output Root 的审批时 inode。 */
  readonly outputRootInode: string;
  /** 经 canonical parent directory 解释后的确切绝对 Markdown 目标路径。 */
  readonly targetCanonicalPath: string;
  /** 目标父目录的审批时设备号，防止同名路径被替换后复用旧审批。 */
  readonly parentDevice: string;
  /** 目标父目录的审批时 inode，防止同名路径被替换后复用旧审批。 */
  readonly parentInode: string;
  /** 对 draft hash 和精确 target component 做 canonical JSON 哈希的聚合摘要。 */
  readonly bindingHash: string;
}

/** 由用户命令签发、可回放的精确 Learning Artifact publication approval。 */
export interface PublicationApprovalReceipt {
  /** 本次 publication approval 事实的跨进程稳定 identity。 */
  readonly approvalId: string;
  /** 审批角色；不得把计划审批解释为发布审批。 */
  readonly kind: "publication";
  /** 唯一允许的审批主体，明确排除模型与 Research Tool。 */
  readonly approvedBy: "user-command";
  /** 用户命令被接受的 ISO 8601 UTC 时间。 */
  readonly approvedAt: string;
  /** Receipt 所授权 Markdown draft 的精确内容 SHA-256。 */
  readonly draftHash: string;
  /** Receipt 所授权 target 所属的 canonical Output Root 路径。 */
  readonly outputRootCanonicalPath: string;
  /** Receipt 所授权 Output Root 的设备号。 */
  readonly outputRootDevice: string;
  /** Receipt 所授权 Output Root 的 inode。 */
  readonly outputRootInode: string;
  /** Receipt 所授权的 canonical Markdown 目标路径。 */
  readonly targetCanonicalPath: string;
  /** Receipt 所授权目标父目录的设备号。 */
  readonly parentDevice: string;
  /** Receipt 所授权目标父目录的 inode。 */
  readonly parentInode: string;
  /** 覆盖全部 publication component 的聚合审批摘要。 */
  readonly bindingHash: string;
}

/** 成功同目录原子发布后写入 Journal 的外部 Learning Artifact 事实。 */
export interface PublishedLearningArtifact {
  /** 实际写入且与 approval receipt 完全一致的 canonical Markdown 目标路径。 */
  readonly targetCanonicalPath: string;
  /** 实际写入 Markdown 精确 UTF-8 内容的 SHA-256 摘要。 */
  readonly sha256: string;
  /** publisher 成功返回后记录为 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly publishedAt: string;
}

/** 模型提案已被 Evidence Gate 接受、但仍等待用户精确发布审批的 Run 状态。 */
export interface WaitingPublicationApprovalRunState
  extends EvidenceBackedRunStateData {
  /** 判别字段；只有完整 Evidence-backed draft 可以进入该暂停状态。 */
  readonly type: "waiting_publication_approval";
  /** 已存入私有 Artifact Store、可由 reducer 重新渲染验证的 Markdown draft。 */
  readonly draftArtifact: ArtifactReference;
  /** 提供标题、摘要和 Claim 展示顺序的有界模型提案。 */
  readonly proposal: LearningArtifactProposal;
  /** 由 Runtime 捕获并将成为用户审批主体的 canonical Markdown 目标。 */
  readonly publicationTarget: PublicationTarget;
  /** 精确绑定 draft 内容与 publication target identity 的审批摘要。 */
  readonly publicationBinding: PublicationApprovalBinding;
  /** draft 被正式写入 Run Journal 的 ISO 8601 UTC 时间。 */
  readonly proposedAt: string;
  /** 若 draft 来自 Research Loop，保留显式完成时的不确定性；旧显式路径则省略。 */
  readonly completion?: ResearchCompletion | undefined;
}

/** 用户已批准 exact publication binding、等待显式正常写入命令的 Run 状态。 */
export interface ReadyToPublishRunState extends EvidenceBackedRunStateData {
  /** 判别字段；重启不会自动猜测或重放尚未确认的外部写入。 */
  readonly type: "ready_to_publish";
  /** 等待时保存的不可变 Markdown draft artifact。 */
  readonly draftArtifact: ArtifactReference;
  /** 用于重建 draft 精确内容的有界模型提案。 */
  readonly proposal: LearningArtifactProposal;
  /** 已获批准、写入前仍需重新验证的 canonical publication target。 */
  readonly publicationTarget: PublicationTarget;
  /** 当初等待状态计算的 exact publication binding。 */
  readonly publicationBinding: PublicationApprovalBinding;
  /** 已由用户命令持久化的精确 publication authorization。 */
  readonly publicationReceipt: PublicationApprovalReceipt;
  /** 若 draft 来自 Research Loop，保留显式完成时的不确定性；旧显式路径则省略。 */
  readonly completion?: ResearchCompletion | undefined;
}

/** 正常 publisher 返回且 `learning_artifact_published` 已 durably append 后的终态。 */
export interface CompletedRunState extends EvidenceBackedRunStateData {
  /** 判别字段；不能从读取、Evidence 或 approval 事件直接跳入。 */
  readonly type: "completed";
  /** 已发布前保持不变的私有 Markdown draft artifact。 */
  readonly draftArtifact: ArtifactReference;
  /** 用于审计实际 Markdown 内容来源的有界模型提案。 */
  readonly proposal: LearningArtifactProposal;
  /** 实际写入前已绑定且已重验的 canonical publication target。 */
  readonly publicationTarget: PublicationTarget;
  /** 实际发生 external write 前已批准的 exact publication binding。 */
  readonly publicationBinding: PublicationApprovalBinding;
  /** 授权这次 external publication 的 durable user-command receipt。 */
  readonly publicationReceipt: PublicationApprovalReceipt;
  /** 外部 publisher 成功后写入 Journal 的已发布内容 identity。 */
  readonly learningArtifact: PublishedLearningArtifact;
  /** 若 draft 来自 Research Loop，保留显式完成时的不确定性；旧显式路径则省略。 */
  readonly completion?: ResearchCompletion | undefined;
}

/** `learning_artifact_draft_proposed` 事件携带的 gated draft 与 publication binding。 */
export interface LearningArtifactDraftProposedPayload {
  /** 已私有持久化的精确 Markdown draft artifact。 */
  readonly draftArtifact: ArtifactReference;
  /** 只含标题、摘要与既有 Claim 选择的有界模型提案。 */
  readonly proposal: LearningArtifactProposal;
  /** 由 Runtime 解析而非模型输出的 canonical publication target。 */
  readonly publicationTarget: PublicationTarget;
  /** 逐字段绑定 draft 与 target 的等待审批摘要。 */
  readonly publicationBinding: PublicationApprovalBinding;
}

/** `publication_approved` 事件携带的用户审批事实。 */
export interface PublicationApprovedPayload {
  /** 只能由用户命令创建且必须精确匹配等待 binding 的 Receipt。 */
  readonly publicationReceipt: PublicationApprovalReceipt;
}

/** `learning_artifact_published` 事件携带的正常外部写入确认事实。 */
export interface LearningArtifactPublishedPayload {
  /** publisher 成功后得到的 exact target/content identity。 */
  readonly learningArtifact: PublishedLearningArtifact;
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
  | RunEvent<"plan_approved", PlanApprovedPayload>
  | RunEvent<"model_turn_completed", ModelTurnCompletedPayload>
  | RunEvent<"research_tool_observed", ResearchToolObservedPayload>
  | RunEvent<"research_completed", ResearchCompletedPayload>
  | RunEvent<"run_budget_exhausted", RunBudgetExhaustedPayload>
  | RunEvent<"source_read_observed", SourceReadObservedPayload>
  | RunEvent<"evidence_recorded", EvidenceRecordedPayload>
  | RunEvent<"claim_recorded", ClaimRecordedPayload>
  | RunEvent<
      "learning_artifact_draft_proposed",
      LearningArtifactDraftProposedPayload
    >
  | RunEvent<"publication_approved", PublicationApprovedPayload>
  | RunEvent<
      "learning_artifact_published",
      LearningArtifactPublishedPayload
    >;

/** 已写入 Artifact Store、等待登记到 SQLite 的元数据。 */
export interface PersistedArtifact extends ArtifactReference {
  /** artifact 首次写入 Runtime Home 的时间，ISO 8601 UTC 字符串。 */
  readonly createdAt: string;
}

/** 私有 Source Snapshot namespace 中不可变源字节的专用引用。 */
export interface SourceSnapshotReference {
  /** 与通用 artifact identity 隔离的 `source-sha256:<hex>` identity。 */
  readonly snapshotId: string;
  /** 完整源文件精确字节的 64 位小写十六进制 SHA-256 摘要。 */
  readonly sha256: string;
  /** 固定的 UTF-8 文本媒体类型，不接受调用方覆盖。 */
  readonly mediaType: "text/plain; charset=utf-8";
  /** 完整源文件的精确字节数，单位为 byte。 */
  readonly byteLength: number;
  /** 相对于 canonical Runtime Home 的私有 snapshot 路径。 */
  readonly relativePath: string;
}

/** 已原子发布到私有 namespace、等待 Task 2 独立登记的 Source Snapshot。 */
export interface PersistedSourceSnapshot extends SourceSnapshotReference {
  /** snapshot 显式 capture 操作的 ISO 8601 UTC 时间。 */
  readonly createdAt: string;
}

/** 每个 Source Read Observation 都必须携带的安全 lineage 字段。 */
export interface SourceReadObservationFields {
  /** 一次 observation 的稳定 identity，不与 event identity 混用。 */
  readonly observationId: string;
  /** Harness 内部生成的 Research Tool call identity。 */
  readonly toolCallId: string;
  /** 固定工具名，避免其他工具结果伪装成来源读取。 */
  readonly toolName: "read_source";
  /** 对调用方精确结构化请求做 canonical JSON SHA-256 得到的摘要。 */
  readonly requestHash: string;
  /** observation 成为 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly observedAt: string;
}

/** 一次成功读取且已经关联独立 Source Snapshot 的 observation。 */
export interface SucceededSourceReadObservation
  extends SourceReadObservationFields {
  /** 判别字段，表示显式读取、快照与 Journal 登记均成功。 */
  readonly status: "succeeded";
  /** 实际命中的已批准 Source Root 零基索引。 */
  readonly rootIndex: number;
  /** realpath containment 后相对于批准根的规范 POSIX 路径。 */
  readonly relativePath: string;
  /** 实际摘录首行，使用 1-based inclusive 语义。 */
  readonly startLine: number;
  /** 实际摘录末行，使用 1-based inclusive 语义。 */
  readonly endLine: number;
  /** 成功读取时完整 UTF-8 文件的逻辑行数。 */
  readonly totalLines: number;
  /** 从完整快照派生、用 LF 连接且不包含额外上下文的摘录。 */
  readonly excerpt: string;
  /** 对摘录原始 UTF-8 编码计算的 64 位小写十六进制 SHA-256。 */
  readonly excerptHash: string;
  /** 冻结本次显式读取所见完整源字节的独立私有快照引用。 */
  readonly sourceSnapshot: SourceSnapshotReference;
  /** 完整源文件的精确字节数，必须与快照引用一致。 */
  readonly byteLength: number;
}

/** 一次被 Source Scope 或预算策略拒绝的安全 observation。 */
export interface DeniedSourceReadObservation extends SourceReadObservationFields {
  /** 判别字段，表示没有获得可发布的源内容。 */
  readonly status: "denied";
  /** 不包含请求路径、字节或系统消息的稳定策略代码。 */
  readonly code: SourceAccessDenialCode;
}

/** 一次因稳定归一化文件系统结果而失败的安全 observation。 */
export interface FailedSourceReadObservation extends SourceReadObservationFields {
  /** 判别字段，表示策略允许评估但文件系统未返回内容。 */
  readonly status: "failed";
  /** 不包含绝对路径或原始 OS 错误的稳定失败代码。 */
  readonly code: SourceAccessFailureCode;
}

/** Run Journal 可持久化的完整 Source Read Observation 联合。 */
export type SourceReadObservation =
  | SucceededSourceReadObservation
  | DeniedSourceReadObservation
  | FailedSourceReadObservation;

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
  /** source read 与 Evidence event 共同暴露的安全 Research Tool call lineage。 */
  readonly toolCallId?: string;
  /** source read 与 Evidence event 共同暴露的成功 observation identity。 */
  readonly observationId?: string;
  /** 仅 `source_read_observed` 暴露的成功、拒绝或失败状态。 */
  readonly observationStatus?: SourceReadObservation["status"];
  /** 成功来源读取与 Evidence event 暴露的私有 Source Snapshot identity。 */
  readonly sourceSnapshotId?: string;
  /** 仅 `evidence_recorded` 暴露的结构化 Evidence identity。 */
  readonly evidenceId?: string;
  /** 仅 `claim_recorded` 暴露的结构化 Claim identity。 */
  readonly claimId?: string;
  /** 仅 draft proposal 事件暴露的私有 content-addressed Markdown artifact identity。 */
  readonly draftArtifactId?: string;
  /** 仅 publication approval 事件暴露的 durable receipt identity。 */
  readonly publicationApprovalId?: string;
  /** 仅完成发布事件暴露的已写入 Markdown 内容 SHA-256。 */
  readonly learningArtifactSha256?: string;
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
