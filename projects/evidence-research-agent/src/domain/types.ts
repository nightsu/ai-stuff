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

/** Harness 为一个逻辑模型或工具操作冻结的有界自动重试配置。 */
export interface RetryPolicy {
  /** 配置的稳定版本，用于 Trace 解释同一操作采用了哪套策略。 */
  readonly version: string;
  /** 一个逻辑 Model Turn 最多允许的物理 generation attempts 数。 */
  readonly modelMaxAttempts: number;
  /** 一个逻辑只读 Research Tool 最多允许的物理执行 attempts 数。 */
  readonly toolMaxAttempts: number;
  /** 第一次自动 retry 的 Harness backoff，单位为毫秒。 */
  readonly baseDelayMs: number;
  /** 本地指数 backoff 的毫秒上限；provider 最短等待 hint 可以超过此值。 */
  readonly maxDelayMs: number;
}

/** Run Journal 对失败原因采用的稳定、无秘密错误分类。 */
export type FailureCategory =
  | "infrastructure_transient"
  | "model_contract"
  | "model_permanent"
  | "permission_denied"
  | "stale_state"
  | "tool_execution"
  | "invariant_violation";

/** 可持久化到 Journal 与 Trace 的规范化失败事实。 */
export interface NormalizedFailure {
  /** 不依赖 provider SDK 或原始异常类型的稳定类别。 */
  readonly category: FailureCategory;
  /** 不包含消息、路径、凭据或 provider payload 的稳定机器代码。 */
  readonly code: string;
  /** provider 建议的最短 retry 等待；没有可信 hint 时省略。 */
  readonly retryAfterMs?: number | undefined;
}

/** Harness 当前支持自动 retry 的两类 Retry Sequence。 */
export type RetrySequenceKind = "model_turn" | "search_sources";

/** 一个物理外部调用开始后、尚未得到 canonical 结果的 attempt。 */
export interface InProgressRetryAttempt {
  /** 物理 attempt 的跨进程稳定 identity。 */
  readonly attemptId: string;
  /** 多次物理 Retry Attempts 共享的 Retry Sequence identity。 */
  readonly retrySequenceId: string;
  /** attempt 对应 Model Turn generation 或只读 search。 */
  readonly retrySequenceKind: RetrySequenceKind;
  /** 同一 Retry Sequence 内从 1 开始严格递增的 attempt 序号。 */
  readonly attemptNumber: number;
  /** 本次 Retry Sequence 首次开始时冻结的完整 Retry Policy。 */
  readonly retryPolicy: RetryPolicy;
  /** 外部调用开始前已提交 Journal 的 ISO 8601 UTC 时间。 */
  readonly startedAt: string;
  /** 判别字段；表示进程重启时必须先恢复此未完成 attempt。 */
  readonly outcome: "in_progress";
  /** search attempts 共享的逻辑 Research Tool call identity。 */
  readonly toolCallId?: string | undefined;
  /** search attempts 对应的 durable pending intent identity。 */
  readonly intentId?: string | undefined;
  /** Model retry 必须跨重启保留的最新非空 steering。 */
  readonly latestSteering?: string | undefined;
}

/** 一个已完成且结果可由 Journal 精确解释的物理 attempt。 */
export interface CompletedRetryAttempt
  extends Omit<InProgressRetryAttempt, "outcome"> {
  /** attempt 成功、仍可重试、已耗尽重试或永久失败的规范结果。 */
  readonly outcome:
    | "succeeded"
    | "retryable_failure"
    | "retry_exhausted"
    | "permanent_failure";
  /** attempt 结束并形成 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly completedAt: string;
  /** `completedAt - startedAt` 的非负整数毫秒值。 */
  readonly durationMs: number;
  /** 失败 attempt 的规范化原因；成功时必须省略。 */
  readonly failure?: NormalizedFailure | undefined;
  /** Harness 在下一 attempt 前实际采用的有界等待；不重试时省略。 */
  readonly retryDelayMs?: number | undefined;
}

/** Projection 按 Journal 顺序保留的完整 attempt 联合。 */
export type RetryAttempt =
  | InProgressRetryAttempt
  | CompletedRetryAttempt;

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
  /** live Run 创建时完整 Experiment Identity 的规范 JSON SHA-256；legacy Run 省略。 */
  readonly experimentIdentityHash?: string | undefined;
  /** 自动 retry 启用时所授权策略的稳定版本；legacy Run 省略。 */
  readonly retryPolicyVersion?: string | undefined;
  /** 自动 retry 启用时完整策略的规范 JSON SHA-256；legacy Run 省略。 */
  readonly retryPolicyHash?: string | undefined;
  /** 对全部存在的组成字段再次规范哈希得到的聚合审批摘要。 */
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
  /** Receipt 所授权 Experiment Identity 的规范 JSON SHA-256；legacy Run 省略。 */
  readonly experimentIdentityHash?: string | undefined;
  /** Receipt 所授权 Retry Policy 的稳定版本；legacy Run 省略。 */
  readonly retryPolicyVersion?: string | undefined;
  /** Receipt 所授权完整 Retry Policy 的规范 JSON SHA-256；legacy Run 省略。 */
  readonly retryPolicyHash?: string | undefined;
}

/** 用户命令对一个更大 Run Budget 版本的独立持久授权。 */
export interface RunBudgetApprovalReceipt {
  /** 本次预算扩展授权的稳定 identity。 */
  readonly approvalId: string;
  /** 判别字段；不得与计划或发布审批混用。 */
  readonly kind: "run_budget_extension";
  /** 固定为显式用户命令，模型和 Research Tool 不能创建该授权。 */
  readonly approvedBy: "user-command";
  /** 授权成为 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly approvedAt: string;
  /** 被替换的前一 Run Budget 稳定版本。 */
  readonly previousBudgetVersion: string;
  /** 被替换的完整前一 Run Budget canonical JSON SHA-256。 */
  readonly previousBudgetHash: string;
  /** 新批准 Run Budget 的稳定版本。 */
  readonly runBudgetVersion: string;
  /** 新批准完整 Run Budget canonical JSON SHA-256。 */
  readonly runBudgetHash: string;
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

/** 一组不含凭据、足以区分一次 live-model 实验配置的稳定身份。 */
export interface ExperimentIdentity {
  /** OpenAI-compatible endpoint 的逻辑 provider 名称，不包含 URL 或 credential。 */
  readonly provider: string;
  /** provider 接收的精确模型标识。 */
  readonly model: string;
  /** 项目自有 Model Port adapter 行为版本。 */
  readonly adapterVersion: string;
  /** 构建 provider request 的 prompt 模板版本。 */
  readonly promptVersion: string;
  /** 暴露给模型的 Research Tool schema 集合版本。 */
  readonly toolSchemaVersion: string;
}

/** provider-neutral token usage；provider 未报告的细分项使用 `undefined`。 */
export interface ModelUsage {
  /** provider 计入 prompt/context 的 token 数。 */
  readonly inputTokens?: number | undefined;
  /** provider 计入生成结果的 token 数。 */
  readonly outputTokens?: number | undefined;
  /** provider 报告的 input 与 output token 总数。 */
  readonly totalTokens?: number | undefined;
  /** input token 中命中 provider cache 的数量。 */
  readonly cachedInputTokens?: number | undefined;
  /** output token 中由 provider 标为 reasoning 的数量。 */
  readonly reasoningTokens?: number | undefined;
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
  /** 完整 generation 的 provider-neutral token usage；legacy fixture 可省略。 */
  readonly usage?: ModelUsage | undefined;
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
  /** 非成功 observation 的稳定规范失败；成功时必须省略。 */
  readonly failure?: NormalizedFailure | undefined;
  /** 不含绝对路径、秘密或原始异常的紧凑确定性摘要。 */
  readonly summary: string;
  /** 成功时的最小 typed output；失败或拒绝时省略。 */
  readonly output?: ResearchToolOutput | undefined;
  /** Harness 按模型 intent 顺序分配的 ISO 8601 UTC 逻辑时间；event 另记真实完成时间。 */
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
  /** 最近的 durable Evidence Gate 问题与 Harness 建议的确定性修复动作。 */
  readonly evidenceGateRepairs: readonly EvidenceGateRepair[];
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
  /** 按 Journal 顺序保留、等待 Research Loop 修复的 Evidence Gate 反馈。 */
  readonly evidenceGateRepairs: readonly EvidenceGateRepair[];
  /** 已 durable 提交但尚未得到 observation 的有序 tool intents。 */
  readonly pendingToolIntents: readonly ResearchToolIntent[];
  /** 最近一次进入 Model View 的非空用户 steering。 */
  readonly latestSteering?: string | undefined;
  /** 第一个 Research Loop Model Turn 的 ISO 8601 UTC 时间；审批等待不计入 wall time。 */
  readonly researchStartedAt?: string | undefined;
  /** user pause 与 budget exhaustion 等 Suspended Run 期间累计不计费的毫秒数。 */
  readonly suspendedDurationMs: number;
  /** 物理 Model/search attempts 的 canonical 历史；不计作额外逻辑 tool calls。 */
  readonly retryAttempts: readonly RetryAttempt[];
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

/** 预算暂停发生时 Research Loop 尚未显式完成的状态。 */
export interface IncompleteBudgetExhaustedRunState
  extends EvidenceBackedRunStateData {
  /** 判别字段；该状态不能发布，也不能伪装为研究成功。 */
  readonly type: "budget_exhausted";
  /** 明确表示暂停前没有成功消费 `complete_research`。 */
  readonly researchOutcome: "incomplete";
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

/** 显式完成后才发现硬预算已耗尽的 Suspended Run。 */
export interface CompletedResearchBudgetExhaustedRunState
  extends EvidenceBackedRunStateData {
  /** 判别字段；该状态仍是暂停而不是可发布成功。 */
  readonly type: "budget_exhausted";
  /** 明确表示 `complete_research` 已成功，但预算事实阻止进入 Gate。 */
  readonly researchOutcome: "research_complete";
  /** 预算暂停仍保留模型显式报告的未解决问题。 */
  readonly completion: ResearchCompletion;
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

/** 一个硬预算维度耗尽后保留精确可恢复事实的 Suspended Run。 */
export type BudgetExhaustedRunState =
  | IncompleteBudgetExhaustedRunState
  | CompletedResearchBudgetExhaustedRunState;

/** 自动 retry 已达到冻结策略边界后的 Suspended Run。 */
export interface RetryExhaustedRunState extends EvidenceBackedRunStateData {
  /** 判别字段；该状态不会自动继续采样或执行工具。 */
  readonly type: "retry_exhausted";
  /** 达到 retry 边界的 Retry Sequence identity。 */
  readonly retrySequenceId: string;
  /** 被暂停的模型 generation 或只读 search 类型。 */
  readonly retrySequenceKind: RetrySequenceKind;
  /** 已经开始并保留在 Journal 中的物理 attempts 数。 */
  readonly attemptsUsed: number;
  /** 最后一次失败或未完成 attempt 的安全规范原因。 */
  readonly failure: NormalizedFailure;
}

/** 不应自动修复的模型契约或永久失败形成的 terminal Run。 */
export interface FailedRunState extends EvidenceBackedRunStateData {
  /** 判别字段；terminal failed Run 不得继续研究或发布。 */
  readonly type: "failed";
  /** 导致 Run 终止的 Retry Sequence identity。 */
  readonly retrySequenceId: string;
  /** 失败发生在模型 generation 或只读 search。 */
  readonly retrySequenceKind: RetrySequenceKind;
  /** 不含原始异常或秘密的终止原因。 */
  readonly failure: NormalizedFailure;
}

/** 用户显式暂停时可被完整嵌入、随后精确恢复的工作状态。 */
export type PausableRunState =
  | ResearchingRunState
  | ResearchCompleteRunState
  | ReadyToPublishRunState;

/** 用户暂停形成的可恢复 Suspended Run。 */
export interface UserPausedRunState {
  /** 判别字段；普通推进命令不得越过该暂停。 */
  readonly type: "user_paused";
  /** 暂停前的完整可继续状态；resume 不重新采样已完成工作。 */
  readonly suspendedState: PausableRunState;
  /** 暂停成为 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly pausedAt: string;
}

/** 所有保留 canonical continuation 且允许未来显式恢复的非终态。 */
export type SuspendedRunState =
  | WaitingPlanApprovalRunState
  | WaitingPublicationApprovalRunState
  | BudgetExhaustedRunState
  | RetryExhaustedRunState
  | UserPausedRunState;

/** 用户可终止、但尚未进入不可逆 terminal outcome 的状态。 */
export type CancellableRunState =
  | CreatedRunState
  | PlanningRunState
  | WaitingPlanApprovalRunState
  | ResearchingRunState
  | ResearchCompleteRunState
  | BudgetExhaustedRunState
  | RetryExhaustedRunState
  | WaitingPublicationApprovalRunState
  | ReadyToPublishRunState
  | UserPausedRunState;

/** 用户终止后保留取消前全部事实、且永远不能恢复的 Run 终态。 */
export interface CancelledRunState {
  /** 判别字段；任何新模型、工具、审批或发布工作都必须拒绝。 */
  readonly type: "cancelled";
  /** 取消前的完整状态快照，仅供审计和保留 Evidence/Trace。 */
  readonly cancelledState: CancellableRunState;
  /** 取消成为 Journal 事实的 ISO 8601 UTC 时间。 */
  readonly cancelledAt: string;
}

/** 当前 planning slice 允许出现的最小 Run 状态联合。 */
export type ResearchRunState =
  | CreatedRunState
  | PlanningRunState
  | WaitingPlanApprovalRunState
  | ResearchingRunState
  | ResearchCompleteRunState
  | BudgetExhaustedRunState
  | RetryExhaustedRunState
  | FailedRunState
  | UserPausedRunState
  | CancelledRunState
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
  /** 按 Journal 顺序保留的显式 Run Budget 扩展授权。 */
  readonly runBudgetApprovalReceipts: readonly RunBudgetApprovalReceipt[];
  /** 创建 Run 时由 Model Port 声明的非秘密实验身份；legacy Run 可省略。 */
  readonly experimentIdentity?: ExperimentIdentity | undefined;
  /** 创建 Run 时冻结并进入计划审批边界的自动 retry 策略；legacy Run 省略。 */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** 当前合法状态；不得由独立布尔标记拼装。 */
  readonly state: ResearchRunState;
  /** 已应用的最后一个连续事件序号，从 1 开始。 */
  readonly lastEventSequence: number;
  /** Run 创建时间，ISO 8601 UTC 字符串。 */
  readonly createdAt: string;
  /** 当前投影最后一次语义变化时间，ISO 8601 UTC 字符串。 */
  readonly updatedAt: string;
}

/** 一个 mutating application command 在持有 durable lease 时的稳定类别。 */
export type RunOperationKind =
  | "create_run"
  | "approve_plan"
  | "advance_research"
  | "read_source"
  | "record_evidence"
  | "record_claim"
  | "propose_learning_artifact"
  | "approve_publication"
  | "publish_learning_artifact"
  | "pause_run"
  | "resume_run"
  | "consume_cancellation"
  | "extend_run_budget"
  | "rebuild_projection";

/** 与 Run Journal 分离、只表达 command ownership 的 durable operation lease。 */
export interface RunOperationLease {
  /** lease 所保护的 Research Run identity。 */
  readonly runId: string;
  /** 每次获取时生成、续租和释放都必须匹配的 operation identity。 */
  readonly operationId: string;
  /** 持有 lease 的 Runtime 实例 identity，用于诊断 stale owner。 */
  readonly ownerId: string;
  /** 当前 command 的稳定类别；不能被解释为 Research Run state。 */
  readonly kind: RunOperationKind;
  /** 首次获取 lease 的 ISO 8601 UTC 时间。 */
  readonly acquiredAt: string;
  /** owner 最近一次证明存活的 ISO 8601 UTC 时间。 */
  readonly heartbeatAt: string;
  /** 超过此 ISO 8601 UTC 时间后其他 owner 可以接管。 */
  readonly expiresAt: string;
}

/** 独立于 active lease 持久化的用户 cancellation control request。 */
export interface RunCancellationRequest {
  /** 请求终止的 Research Run identity。 */
  readonly runId: string;
  /** 单次用户取消请求的稳定 identity。 */
  readonly requestId: string;
  /** 请求首次持久化的 ISO 8601 UTC 时间。 */
  readonly requestedAt: string;
  /** 请求已转化为 canonical cancellation fact 的时间；未消费时省略。 */
  readonly consumedAt?: string | undefined;
  /** 消费请求的 operation identity；独立 cancel command 可省略。 */
  readonly consumedByOperationId?: string | undefined;
}

/** 只读观察 control plane，不把 lease 或 request 混入 Run Projection。 */
export interface RunOperationView {
  /** 当前尚未到期的 durable operation lease；没有 active owner 时省略。 */
  readonly lease?: RunOperationLease | undefined;
  /** 最近一次 durable cancellation request；从未请求时省略。 */
  readonly cancellationRequest?: RunCancellationRequest | undefined;
}

/** `run_created` 事件携带的创建事实。 */
export interface RunCreatedPayload {
  /** 创建时去除首尾空白后的技术问题，后续事件不得覆写。 */
  readonly question: string;
  /** 创建时冻结的 Source Scope，后续扩权必须产生新版本。 */
  readonly sourceScope: SourceScope;
  /** 创建时冻结的多维预算；模型输出不得选择或提高这些限制。 */
  readonly runBudget: RunBudget;
  /** Model Port 提供的非秘密实验身份；不得包含 base URL、header 或 API key。 */
  readonly experimentIdentity?: ExperimentIdentity | undefined;
  /** 创建时显式启用并冻结的自动 retry 策略；省略即保持 legacy 单 attempt。 */
  readonly retryPolicy?: RetryPolicy | undefined;
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
  /** 启用 Retry Policy 时必填并与 Model Turn 同事务提交；legacy Run 可省略。 */
  readonly attempt?: CompletedRetryAttempt | undefined;
}

/** `retry_attempt_started` 在外部 I/O 前提交的恢复事实。 */
export interface RetryAttemptStartedPayload {
  /** outcome 固定为 `in_progress` 的完整 attempt。 */
  readonly attempt: InProgressRetryAttempt;
}

/** `retry_attempt_failed` 为未完成 Retry Sequence 保存的安全失败事实。 */
export interface RetryAttemptFailedPayload {
  /** 与先前 started attempt 精确匹配的失败完成结果。 */
  readonly attempt: CompletedRetryAttempt;
}

/** `run_retry_exhausted` 将耗尽的 Retry Sequence 转为显式 Suspended Run。 */
export interface RunRetryExhaustedPayload {
  /** 达到 retry 边界的 Retry Sequence identity。 */
  readonly retrySequenceId: string;
  /** 被暂停的模型 generation 或只读 search 类型。 */
  readonly retrySequenceKind: RetrySequenceKind;
  /** 已持久化的 attempt 数量。 */
  readonly attemptsUsed: number;
  /** 最后一次 retryable 或 interrupted failure。 */
  readonly failure: NormalizedFailure;
}

/** `run_failed` 保存不可自动修复的 terminal failure。 */
export interface RunFailedPayload {
  /** 导致失败的 Retry Sequence identity。 */
  readonly retrySequenceId: string;
  /** 失败发生在模型 generation 或只读 search。 */
  readonly retrySequenceKind: RetrySequenceKind;
  /** 规范化且不得携带秘密的永久失败原因。 */
  readonly failure: NormalizedFailure;
}

/** `research_tool_observed` 事件携带的 Harness 工具反馈。 */
export interface ResearchToolObservedPayload {
  /** 对一个 durable pending intent 的成功、无效、拒绝或失败 observation。 */
  readonly observation: ResearchToolObservation;
  /** 启用 retry 的 search success 时必填并同事务提交；其他 observation 可省略。 */
  readonly attempt?: CompletedRetryAttempt | undefined;
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

/** `run_budget_extended` 携带新限制与对应用户授权。 */
export interface RunBudgetExtendedPayload {
  /** 必须逐维不小于前一版本、且至少提高一个限制的新 Run Budget。 */
  readonly runBudget: RunBudget;
  /** 精确绑定前后预算 hashes 的 durable user approval。 */
  readonly approvalReceipt: RunBudgetApprovalReceipt;
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

/** Learning Artifact 中一个原子且显式分类的可发布主张。 */
export interface Claim {
  /** 由 Runtime 从本次 Journal event identity 派生的稳定 Claim identity。 */
  readonly claimId: string;
  /** 决定 Evidence Gate 与 renderer 如何解释该主张，而不是可互换的显示标签。 */
  readonly kind: "source_fact" | "inference" | "design_recommendation";
  /** 面向 Learning Artifact 的简短主张文本，不能包含渲染后的 citation 字符串。 */
  readonly text: string;
  /**
   * 去重且按调用方明确顺序保存的 Evidence identities。source fact 与 inference
   * 必须非空；design recommendation 可以为空，也可以声明影响该建议的来源。
   */
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

/** Evidence Gate 失败后可持久化并重新注入 Research Loop 的稳定问题代码。 */
export type EvidenceGateRepairCode =
  | "invalid_claim_selection"
  | "unknown_claim_id"
  | "claim_evidence_required"
  | "unknown_evidence_id"
  | "invalid_evidence_kind"
  | "lineage_mismatch"
  | "snapshot_integrity_failure"
  | "snapshot_range_invalid"
  | "excerpt_mismatch"
  | "approval_invalid"
  | "proposal_invalid"
  | "budget_violation";

/** 不消耗 Research Tool 预算、但会成为 Journal 事实的 Evidence Gate repair。 */
export interface EvidenceGateRepair {
  /** 由承载事件 identity 派生的稳定 repair identity。 */
  readonly repairId: string;
  /** Harness 分配的稳定失败分类，模型不能自由编写。 */
  readonly code: EvidenceGateRepairCode;
  /** 面向 Trace/Model View 的简短确定性问题说明。 */
  readonly summary: string;
  /** Harness 给 Research Loop 的具体下一步，而不是开放式错误字符串。 */
  readonly recommendedAction: string;
  /** 本次失败前是否已经完成一次 Artifact proposal Model generation。 */
  readonly artifactProposalTurnConsumed: boolean;
  /** repair 成为 Run Journal 事实的 ISO 8601 UTC 时间。 */
  readonly requestedAt: string;
}

/** `evidence_gate_repair_requested` 事件携带的完整确定性 repair 事实。 */
export interface EvidenceGateRepairRequestedPayload {
  /** reducer 必须按 event identity、code 与时间重新验证的 repair。 */
  readonly repair: EvidenceGateRepair;
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

/** Issue #5 的显式命令路径在 publication 状态保留的研究 provenance。 */
export interface LegacyExplicitPublicationResearchData
  extends EvidenceBackedRunStateData {
  /** 判别字段；该路径未进入 Research Loop。 */
  readonly researchOrigin: "legacy_explicit";
  /** 显式命令路径没有 Research Loop Model Turn。 */
  readonly modelTurns: readonly [];
  /** 显式命令路径没有模型可见 Research Tool observation。 */
  readonly researchToolObservations: readonly [];
  /** 显式命令路径没有模型声明的 evidence gaps。 */
  readonly evidenceGaps: readonly [];
  /** 进入 publication 时不允许遗留 pending Research Tool intent。 */
  readonly pendingToolIntents: readonly [];
  /** 显式命令路径不能伪造 Research Loop steering。 */
  readonly latestSteering?: never;
  /** 显式命令路径没有 Research Loop wall-time 起点。 */
  readonly researchStartedAt?: never;
}

/** `complete_research` 成功后的 publication 状态保留的研究 provenance。 */
export interface ResearchLoopPublicationResearchData
  extends EvidenceBackedRunStateData {
  /** 判别字段；该路径由真正 Research Loop 显式完成。 */
  readonly researchOrigin: "research_loop";
  /** Research Loop publication 至少包含一个 durable Model Turn。 */
  readonly modelTurns: readonly [ModelTurn, ...ModelTurn[]];
  /** 完成工具本身保证至少存在一个模型可见 observation。 */
  readonly researchToolObservations: readonly [
    ResearchToolObservation,
    ...ResearchToolObservation[],
  ];
  /** 进入 publication 时全部 durable intents 都已消费。 */
  readonly pendingToolIntents: readonly [];
  /** 第一个 Model Turn generation 开始时冻结的 wall-time 起点。 */
  readonly researchStartedAt: string;
  /** 显式完成时保留的未解决问题。 */
  readonly completion: ResearchCompletion;
}

/** publication 状态只能来自旧显式路径或已完成 Research Loop 之一。 */
export type PublicationResearchData =
  | LegacyExplicitPublicationResearchData
  | ResearchLoopPublicationResearchData;

/** draft、target 与 binding 在全部 publication 状态共享的事实。 */
export interface PublicationStateData {
  /** 已存入私有 Artifact Store、可由 reducer 重新渲染验证的 Markdown draft。 */
  readonly draftArtifact: ArtifactReference;
  /** 提供标题、摘要和 Claim 展示顺序的有界模型提案。 */
  readonly proposal: LearningArtifactProposal;
  /** 由 Runtime 捕获并将成为用户审批主体的 canonical Markdown 目标。 */
  readonly publicationTarget: PublicationTarget;
  /** 精确绑定 draft 内容与 publication target identity 的审批摘要。 */
  readonly publicationBinding: PublicationApprovalBinding;
}

/** 模型提案已被 Evidence Gate 接受、但仍等待用户精确发布审批的 Run 状态。 */
export type WaitingPublicationApprovalRunState = PublicationResearchData &
  PublicationStateData & {
  /** 判别字段；只有完整 Evidence-backed draft 可以进入该暂停状态。 */
  readonly type: "waiting_publication_approval";
  /** draft 被正式写入 Run Journal 的 ISO 8601 UTC 时间。 */
  readonly proposedAt: string;
};

/** 用户已批准 exact publication binding、等待显式正常写入命令的 Run 状态。 */
export type ReadyToPublishRunState = PublicationResearchData &
  PublicationStateData & {
  /** 判别字段；重启不会自动猜测或重放尚未确认的外部写入。 */
  readonly type: "ready_to_publish";
  /** 已由用户命令持久化的精确 publication authorization。 */
  readonly publicationReceipt: PublicationApprovalReceipt;
};

/** 正常 publisher 返回且 `learning_artifact_published` 已 durably append 后的终态。 */
export type CompletedRunState = PublicationResearchData &
  PublicationStateData & {
  /** 判别字段；不能从读取、Evidence 或 approval 事件直接跳入。 */
  readonly type: "completed";
  /** 授权这次 external publication 的 durable user-command receipt。 */
  readonly publicationReceipt: PublicationApprovalReceipt;
  /** 外部 publisher 成功后写入 Journal 的已发布内容 identity。 */
  readonly learningArtifact: PublishedLearningArtifact;
};

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
  | RunEvent<"retry_attempt_started", RetryAttemptStartedPayload>
  | RunEvent<"retry_attempt_failed", RetryAttemptFailedPayload>
  | RunEvent<"run_retry_exhausted", RunRetryExhaustedPayload>
  | RunEvent<"run_failed", RunFailedPayload>
  | RunEvent<"model_turn_completed", ModelTurnCompletedPayload>
  | RunEvent<"research_tool_observed", ResearchToolObservedPayload>
  | RunEvent<"research_completed", ResearchCompletedPayload>
  | RunEvent<"run_budget_exhausted", RunBudgetExhaustedPayload>
  | RunEvent<"run_budget_extended", RunBudgetExtendedPayload>
  | RunEvent<"run_paused", Record<never, never>>
  | RunEvent<"run_resumed", Record<never, never>>
  | RunEvent<"run_cancelled", Record<never, never>>
  | RunEvent<"source_read_observed", SourceReadObservedPayload>
  | RunEvent<"evidence_recorded", EvidenceRecordedPayload>
  | RunEvent<"claim_recorded", ClaimRecordedPayload>
  | RunEvent<
      "evidence_gate_repair_requested",
      EvidenceGateRepairRequestedPayload
    >
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
  /** Harness 按模型 intent 顺序分配的 ISO 8601 UTC 逻辑时间；event 另记真实完成时间。 */
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
  /** Claim 事件暴露的分类，供 artifact Claim label 直接 join Trace。 */
  readonly claimKind?: Claim["kind"];
  /** Claim 事件按原始顺序暴露的 Evidence identities。 */
  readonly evidenceIds?: readonly string[];
  /** Evidence Gate repair 事件暴露的稳定问题代码。 */
  readonly evidenceGateRepairCode?: EvidenceGateRepairCode;
  /** 仅 draft proposal 事件暴露的私有 content-addressed Markdown artifact identity。 */
  readonly draftArtifactId?: string;
  /** 仅 publication approval 事件暴露的 durable receipt identity。 */
  readonly publicationApprovalId?: string;
  /** 仅完成发布事件暴露的已写入 Markdown 内容 SHA-256。 */
  readonly learningArtifactSha256?: string;
  /** Retry Attempt 事件或原子成功事件对应的 Retry Sequence identity。 */
  readonly retrySequenceId?: string;
  /** attempt 或 terminal failure 对应的 Retry Sequence 类型。 */
  readonly retrySequenceKind?: RetrySequenceKind;
  /** Trace 中物理外部调用从 1 开始的 attempt 序号。 */
  readonly attemptNumber?: number;
  /** attempt 的规范化最终结果；started 事件使用 `in_progress`。 */
  readonly attemptOutcome?: RetryAttempt["outcome"];
  /** completed attempt 的实际墙钟耗时，单位为毫秒。 */
  readonly attemptDurationMs?: number;
  /** 本 Retry Sequence 首次开始时冻结的 Retry Policy 版本。 */
  readonly retryPolicyVersion?: string;
  /** 失败 attempt 或失败 observation 的稳定类别。 */
  readonly failureCategory?: FailureCategory;
  /** 不含原始异常或秘密的稳定失败代码。 */
  readonly failureCode?: string;
  /** 下一 attempt 前由 Harness 实际采用的等待毫秒数。 */
  readonly retryDelayMs?: number;
}

/** 面向人或机器读取、但不作为 canonical history 的 Run Trace。 */
export interface RunTrace {
  /** Trace 对应的 Research Run identity。 */
  readonly runId: string;
  /** live Run 的非秘密实验身份；legacy Run 可省略。 */
  readonly experimentIdentity?: ExperimentIdentity | undefined;
  /** 回放全部事件后得到的当前状态。 */
  readonly finalState: ResearchRunState["type"];
  /** 按 Journal 顺序投影出的精简事件列表。 */
  readonly events: readonly RunTraceEvent[];
}
