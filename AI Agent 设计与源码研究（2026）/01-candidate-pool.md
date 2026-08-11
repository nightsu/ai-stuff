# 完整候选池、社区快照与影响谱系

> 快照日期：2026-07-31。表格是研究时从 GitHub 官方仓库/API 字段抄录的日期级历史记录；原始 API payload 和日内抓取时间未留存，不能把它描述为本包内可重放的原始快照。`Open` 是开放 issue 与开放 PR 的合计，不等于 bug 数；`has_discussions` 只是仓库是否启用 Discussions 的布尔字段，不是讨论数量。可机读转录见 [`data/community-snapshot-2026-07-31.csv`](data/community-snapshot-2026-07-31.csv)。

## 1. 候选池

### 头部与历史样本

| 项目 | 类型 | Stars | Forks | Open | Contributors* | has_discussions | 最近 push | 最新 release | 许可 |
|---|---|---:|---:|---:|---:|---|---|---|---|
| [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | Agent 平台/历史自主 Agent | 185,749 | 46,059 | 512 | 838 | 否 | 2026-07-31 | beta v0.6.70 | API: NOASSERTION |
| [browser-use](https://github.com/browser-use/browser-use) | 浏览器 Agent | 107,396 | 11,815 | 343 | 334 | 是 | 2026-07-31 | 0.13.7 | MIT |
| [OpenHands](https://github.com/OpenHands/OpenHands) | 软件开发 Agent 平台 | 82,681 | 10,626 | 276 | 506 | 否 | 2026-07-31 | v1.8.0 | MIT |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | SOP 多 Agent | 69,606 | 8,869 | 140 | 148 | 否 | 2026-01-21 | v0.8.1（2024） | MIT |
| [AutoGen](https://github.com/microsoft/autogen) | 消息型多 Agent | 60,129 | 9,059 | 972 | 534 | 是 | 2026-04-15 | python-v0.7.5 | 分路径核对 |
| [OpenManus](https://github.com/FoundationAgents/OpenManus) | 通用 Agent 参考实现 | 57,795 | 10,049 | 495 | 60 | 是 | 2026-02-11 | v0.3.0（2025） | MIT |
| [CrewAI](https://github.com/crewAIInc/crewAI) | Crew/Flow 编排 | 56,430 | 8,026 | 724 | 301 | 否 | 2026-07-31 | 1.15.9 | MIT |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 图 Agent runtime | 38,571 | 6,499 | 652 | 283 | 否 | 2026-07-31 | checkpointsqlite 3.1.1 | MIT |
| [smolagents](https://github.com/huggingface/smolagents) | 极简 CodeAgent | 28,611 | 2,826 | 740 | 207 | 是 | 2026-07-21 | v1.26.0 | Apache-2.0 |
| [DeepAgents](https://github.com/langchain-ai/deepagents) | 长程 Agent harness | 27,158 | 3,797 | 183 | 140 | 是 | 2026-07-31 | 0.7.1 | MIT |
| [BabyAGI](https://github.com/yoheinakajima/babyagi) | 历史 Agent 实验 | 22,341 | 2,856 | 32 | 2 | 否 | 2026-01-31 | 无 | README: MIT |
| [Google ADK](https://github.com/google/adk-python) | Agent toolkit | 20,958 | 3,776 | 592 | 415 | 是 | 2026-07-31 | v2.6.0 | Apache-2.0 |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) | 强类型 Agent 框架 | 18,930 | 2,452 | 608 | 540 | 否 | 2026-07-31 | v2.21.0 | MIT |
| [open_deep_research](https://github.com/langchain-ai/open_deep_research) | 深度研究 Agent | 12,473 | 1,759 | 72 | 26 | 否 | 2026-07-25 | 无 | MIT |

\* Contributors 是 contributors API 分页得到的历史贡献广度近似值，不是当前 maintainer 数。

### 2025–2026 当前候选

| 项目 | 类型 | Stars | Forks | Open | has_discussions | 最近 push | 许可 | 处理 |
|---|---|---:|---:|---:|---|---|---|---|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 终端 coding agent | 106,277 | 14,360 | 988 | 是 | 2026-07-31 | Apache-2.0 | 强候选；篇幅下与 Codex 机制重叠 |
| [OpenAI Codex](https://github.com/openai/codex) | 终端 coding agent | 102,864 | 15,467 | 11,528 | 是 | 2026-07-31 | Apache-2.0 | 入选完整应用层 |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | Agent SDK | 28,316 | 4,410 | 55 | 否 | 2026-07-31 | MIT | 入选 SDK 层 |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | 研究型 coding agent | 19,971 | 2,179 | 54 | 否 | 2026-07-27 | MIT | 学术基线，机制与 Codex/OpenHands 重叠 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | 多 Agent / workflow | 12,515 | 2,099 | 653 | 是 | 2026-07-31 | MIT | 入选当前企业框架层 |

这些字段的**当前值**可从 `https://api.github.com/repos/{owner}/{repo}` 重新查询，字段定义见 [GitHub REST 文档](https://docs.github.com/en/rest/repos/repos#get-a-repository)；重新查询不能证明 2026-07-31 的历史值。正式源码比较冻结代码 SHA，社区数值只能作为带上述 provenance 限制的日期级记录。研究没有采集 discussion 数量或 maintainer response 指标；无法恢复的 discussion 数量统一记为 N/A，不作推断。

### 2026-08-05 追加候选（独立快照）

| 项目 | 类型 | Stars | Forks | Open | Contributors* | has_discussions | 最近 push | 最新 release | 许可 | 处理 |
|---|---|---:|---:|---:|---:|---|---|---|---|---|
| [OpenWorker](https://github.com/andrewyng/openworker) | 本地桌面知识工作 Agent | 12,850 | 1,731 | 378 | 8 | 否 | 2026-08-01 | v0.1.7 | MIT | 纳入追加补充样本；不进入 2026-07-31 九项目总榜 |

OpenWorker 的 [repository API](https://api.github.com/repos/andrewyng/openworker) 显示仓库创建于 2026-07-20；contributors、release 与 CI 证据均在[逐项目研究](agents/07-openworker.md)中单独引用。它填补“桌面知识工作 Agent 的耐久人机协作控制面”类别，但公开时间过短、缺少系统级执行沙箱，且快照日期与主表不同，因此不回填原统一评分。

## 2. 为什么不是按 star 取前九名

- AutoGPT 的 2023 历史原型影响与 2026 平台工程混在一个仓库热度中，难以用单一分数解释。
- Codex、Gemini CLI 是用户产品，stars/issue 来源与 Python library 不同。
- BabyAGI 原版已转入历史状态；极高历史关注不代表当前生产实践。
- MAF stars 低于 AutoGen，但官方维护方向、checkpoint、middleware 与 OTel 更适合当前绿地项目。
- smolagents 不是最完整的生产平台，却因主循环可读性成为更好的教学样本。
- LangGraph 是 runtime，不是完整 Agent 应用；保留它是为了研究可恢复执行机制。

## 3. 可核验的影响谱系

等级：S = 明确建立/采用；A = 明确受启发或承接经验；B = 致谢/局部支持。

| 上游 | 下游 | 等级 | 一方证据能证明什么 |
|---|---|---|---|
| AutoGPT | LlamaIndex `auto_llama` | A | [README 明确称 AutoGPT inspired](https://github.com/run-llama/llama-lab/blob/3364c9eae1dadefccad8fa904296f19e0bf045da/README.md#L10-L11) |
| BabyAGI + AutoGPT | BlockAGI | A | [明确 builds upon 两者](https://github.com/orgexyz/BlockAGI/blob/1632650fb9392aa126c92ae6a4612d9eb34f4937/README.md#L22)，不能拆分贡献 |
| BabyAGI | LangGraphJS Plan-and-Execute | A | [官方示例写 heavily inspired](https://github.com/langchain-ai/langgraphjs/blob/56728fd3bd2c5a9e3a29f8fe6593204b2133a8f8/examples/plan-and-execute/plan-and-execute.ipynb) |
| MetaGPT | AutoAgents | S | [code base 明确 built using MetaGPT](https://github.com/Link-AGI/AutoAgents/blob/223ad991988d752c446d25a0381e647f6e71c92c/README.md#L185) |
| AutoGen | Microsoft Agent Framework | A | [官方后继承接 lessons learned](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/README.md#L177) |
| CrewAI | KnowledgeGraphCrew | S（采用） | [明确 leverages CrewAI](https://github.com/Ronoh4/KnowledgeGraphCrew/blob/4d35f93ad83364f93ba843e88136a5af63969ec7/README.md#L1-L2)，证明采用而非原创继承 |
| OpenHands | OpenManus | B | [公开感谢](https://github.com/FoundationAgents/OpenManus/blob/52a13f2a57d8c7f6737eefb02ccf569594d44273/README.md#L179)，未说明核心架构来源 |
| browser-use | OpenManus | B | [说明提供基础支持](https://github.com/FoundationAgents/OpenManus/blob/52a13f2a57d8c7f6737eefb02ccf569594d44273/README.md#L177)，范围不明 |
| smolagents | IntelLabs DeepMath | S | [推理实现明确 based on smolagents](https://github.com/IntelLabs/DeepMath/blob/18223a3055304249b450ee2d35cc86fc56e4e81c/README.md#L46) |
| open_deep_research | OPEA DeepResearchAgent | S | [明确复用其 agent implementation](https://github.com/opea-project/GenAIExamples/blob/f56422671c8bdf46f59dd758c8c9e38ca41d6555/DeepResearchAgent/README.md#L7) |
| DeepAgents | OpenShell DeepAgent | S | [明确由 Deep Agents 编排](https://github.com/langchain-ai/openshell-deepagent/blob/1af69a9c86942ab72ad533600d13e2e4ee126695/README.md#L1-L3) |

注意三类证据不能互换：`built with` 证明采用，`inspired by` 证明设计影响，`thanks` 只证明致谢。依赖 LangGraph、Playwright、Pydantic 或 MCP 只证明技术依赖；模型在回答中提到某项目没有可重复观测方法，不计入影响分。

## 4. 排除与降级记录

| 项目 | 处理 | 理由 |
|---|---|---|
| AutoGPT | 候选池保留，不逐篇 | 历史原型和当前平台边界混合；仓库级许可 API 为 NOASSERTION |
| BabyAGI | 历史谱系 | 原版历史价值高，当前生产价值低 |
| MetaGPT | 多 Agent SOP 备选 | 原创主张清楚，但 release 与当前活跃度弱于核心集 |
| Gemini CLI | coding agent 强备选 | 与 Codex 同题异构很有价值，但本研究优先扩大机制覆盖 |
| DeepAgents | 长程 harness 强备选 | 已建立在 LangGraph 等底层能力上，本轮先审计运行时 |
| Google ADK / Pydantic AI | 框架强备选 | 现实价值高，但与已选 SDK/runtime 机制覆盖重叠 |
| OpenManus | 下游组合样本 | stars 高，但一方 acknowledgement 显示其大量组合上游，不以热度推断原创性 |
| SWE-agent | 学术基线 | 论文边界清晰，但 coding-agent 类已有 Codex/OpenHands |
