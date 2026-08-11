# 评分证据账本

本账本让 [`10-comparison.md`](10-comparison.md) 的每个分项可追溯、总分可复算。它记录的是依据冻结源码和一方材料做出的**结构化分析者证据评分**，不是运行 benchmark 或统计测量。评分锚点、插值规则和限制见[方法文档](00-methodology.md#2-可审计评分框架)。每个“证据入口”都指向逐项目研究；其中的固定 SHA 链接才是源码级证据。标为“原创性路径”的判断是分析者对源码机制组合的归纳，不冒充上游自称；一方设计说明只在实际存在时作为增强证据。

## 1. 运行时 / SDK

### 1.1 LangGraph — 87/100

证据入口：[LangGraph 研究](agents/03-langgraph.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 17/20 | 头部 runtime 采用、贡献广且快照日活跃。 |
| 原创性与影响 | 18/20 | **原创性路径**：reducer、BSP/superstep、checkpoint 与 interrupt 构成相互配合的状态运行时体系；高分来自固定 SHA 源码共同支持的机制组合，是分析者归纳，不依赖下游继承或未核验的设计文档。 |
| 执行与状态 | 20/20 | 图执行、并发合并、checkpoint、interrupt 与恢复语义完整。 |
| 安全控制面覆盖 | 10/15 | interrupt/HITL 明确，外部副作用策略与隔离多交给集成方。 |
| 可观测与质量 | 9/10 | 状态流、checkpoint、stream 和测试面丰富。 |
| 可学习与迁移 | 8/10 | 抽象清楚，但 runtime 层概念密度高。 |
| 维护与许可 | 5/5 | 快照日活跃且 MIT。 |

### 1.2 Microsoft Agent Framework — 84/100

证据入口：[MAF 研究](agents/09-microsoft-agent-framework.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 14/20 | 日期级记录为 12,515 stars、2,099 forks、最近 push 2026-07-31，且 `has_discussions=true`；contributors 为 N/A，不用它加分，也不声称贡献广度。 |
| 原创性与影响 | 16/20 | 融合 Agent、Workflow 与 middleware，并有官方承接 AutoGen 经验的 A 级谱系证据。 |
| 执行与状态 | 19/20 | executor、checkpoint、pending request 与恢复边界完整。 |
| 安全控制面覆盖 | 13/15 | approval middleware、session policy 等多层控制 primitives 可追。 |
| 可观测与质量 | 10/10 | OpenTelemetry、middleware、事件和测试支撑完整。 |
| 可学习与迁移 | 7/10 | 跨语言和大表面积提高学习门槛。 |
| 维护与许可 | 5/5 | 快照日活跃且 MIT。 |

### 1.3 OpenAI Agents SDK — 87/100

证据入口：[Agents SDK 研究](agents/02-openai-agents-sdk.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 15/20 | 日期级记录为 28,316 stars、4,410 forks、最近 push 2026-07-31，且 `has_discussions=false`；未使用未采集的 contributors 或 latest release。 |
| 原创性与影响 | 16/20 | **原创性路径**：handoff、guardrail 与 RunState 以少量公共原语形成辨识度高的组合；16 分不声称存在明确下游继承。 |
| 执行与状态 | 18/20 | Runner、NextStep、可序列化中断与恢复链完整。 |
| 安全控制面覆盖 | 14/15 | tool guardrail、approval、sandbox hooks 等控制点全面。 |
| 可观测与质量 | 10/10 | trace、session、typed items 与测试面完整。 |
| 可学习与迁移 | 9/10 | 公共原语少，核心路径适合教学迁移。 |
| 维护与许可 | 5/5 | 快照日活跃且 MIT。 |

### 1.4 CrewAI — 79/100

证据入口：[CrewAI 研究](agents/08-crewai.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 18/20 | 高 stars、贡献广且快照日活跃。 |
| 原创性与影响 | 15/20 | Crew/Flow 双层 UX 有明显产品化影响。 |
| 执行与状态 | 16/20 | Task/Crew 与 Flow 状态可追，持久化层次较多且语义不完全统一。 |
| 安全控制面覆盖 | 10/15 | 工具/Agent 策略与 HITL 可组合，强隔离多由集成方承担。 |
| 可观测与质量 | 8/10 | 事件、trace 集成和测试证据较强。 |
| 可学习与迁移 | 7/10 | 上手容易，但双层/多状态系统增加迁移成本。 |
| 维护与许可 | 5/5 | 快照日活跃且 MIT。 |

### 1.5 smolagents — 75/100

证据入口：[smolagents 研究](agents/01-smolagents.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 15/20 | 稳定采用、贡献较广、快照日前近期发布。 |
| 原创性与影响 | 17/20 | 极简 ReAct/CodeAct 路径具有辨识度，并有 DeepMath 明确采用的 S 级一方证据。 |
| 执行与状态 | 13/20 | 显式 step/memory，但缺少一等跨进程 durable resume。 |
| 安全控制面覆盖 | 8/15 | schema 与 executor 边界可见；本地解释器明确不是安全 sandbox。 |
| 可观测与质量 | 7/10 | monitor/callback、memory 与测试可见，生产观测面较轻。 |
| 可学习与迁移 | 10/10 | 主循环最短、最适合逐行复现。 |
| 维护与许可 | 5/5 | 快照日仍活跃且 Apache-2.0。 |

### 1.6 AutoGen（历史） — 77/100

证据入口：[AutoGen 历史研究](agents/10-autogen-historical.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 18/20 | 历史采用和贡献广度高。 |
| 原创性与影响 | 20/20 | topic/message runtime 与 selector 构成原创机制体系，且 MAF 官方明确承接其经验，原创与 A 级影响两条路径都有证据。 |
| 执行与状态 | 15/20 | 异步消息、Agent state 可追，但 subscription/in-flight queue 不随状态保存。 |
| 安全控制面覆盖 | 8/15 | 消息 handler 可承载策略，强审批/隔离主要由应用承担。 |
| 可观测与质量 | 7/10 | message/event runtime 清楚，但当前质量投入转向后继。 |
| 可学习与迁移 | 8/10 | 消息型多 Agent 概念仍具教学价值。 |
| 维护与许可 | 1/5 | 官方 maintenance mode，绿地项目应转向 MAF。 |

## 2. 完整 Agent 应用

### 2.1 Codex — 92/100

证据入口：[Codex 研究](agents/05-codex.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 20/20 | 日期级记录为 102,864 stars、15,467 forks、最近 push 2026-07-31，且 `has_discussions=true`；未使用未采集的 contributors 或 latest release。 |
| 原创性与影响 | 17/20 | **原创性路径**：typed lifecycle、统一 harness 与工具执行面形成辨识度高的产品架构；17 分不声称已证实外部核心继承。 |
| 执行与状态 | 19/20 | turn loop、history、取消、compaction 和工具记账链完整。 |
| 安全控制面覆盖 | 15/15 | 公开审批、sandbox、policy、network 与工具路由 primitives 覆盖完整；**不代表有效性实测或生产 L4**。 |
| 可观测与质量 | 9/10 | typed protocol/events 与测试面丰富。 |
| 可学习与迁移 | 7/10 | 可迁移原则强，但 Rust 产品代码表面积很大。 |
| 维护与许可 | 5/5 | 快照日活跃且 Apache-2.0。 |

### 2.2 OpenHands — 91/100

证据入口：[OpenHands 研究](agents/06-openhands.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 18/20 | 头部应用仓采用、贡献广且快照日活跃。 |
| 原创性与影响 | 19/20 | **原创性路径**：UI—Server—SDK—Workspace 分层与事件化会话共同形成完整系统范式；OpenManus 的 B 级 `thanks` 仅是致谢，不作为核心继承或 19 分依据。 |
| 执行与状态 | 19/20 | event log、视图重建、pending action 与资源锁恢复链完整。 |
| 安全控制面覆盖 | 14/15 | workspace、security analyzer、confirmation 与资源边界多层覆盖。 |
| 可观测与质量 | 9/10 | 事件日志、metrics、hooks 和测试面丰富。 |
| 可学习与迁移 | 7/10 | 架构价值高，但需跨仓/跨层阅读。 |
| 维护与许可 | 5/5 | 快照日活跃且 MIT。 |

### 2.3 browser-use — 88/100

证据入口：[browser-use 研究](agents/04-browser-use.md)

| 维度 | 分数 | 证据理由 |
|---|---:|---|
| 采用与社区 | 20/20 | 头部垂直 Agent 采用，快照日活跃。 |
| 原创性与影响 | 19/20 | **原创性路径**：DOM、视觉、selector 与 action 被重构为相互配合的浏览器领域闭环；OpenManus 的 B 级基础支持致谢不证明核心继承，也不作为 19 分依据。 |
| 执行与状态 | 17/20 | step loop、history、重观察/重试完整，跨进程 exactly-once 不成立。 |
| 安全控制面覆盖 | 11/15 | domain/action/browser policy 可见，系统级审批与隔离覆盖较少。 |
| 可观测与质量 | 8/10 | history、cost、step telemetry 与测试面较强。 |
| 可学习与迁移 | 8/10 | 领域抽象清楚，但浏览器状态复杂。 |
| 维护与许可 | 5/5 | 快照日活跃且 MIT。 |

## 3. 复算与解读

| 项目 | 七维加总 | 表中总分 | 校验 |
|---|---:|---:|---|
| LangGraph | 17+18+20+10+9+8+5 | 87 | 一致 |
| Microsoft Agent Framework | 14+16+19+13+10+7+5 | 84 | 一致 |
| OpenAI Agents SDK | 15+16+18+14+10+9+5 | 87 | 一致 |
| CrewAI | 18+15+16+10+8+7+5 | 79 | 一致 |
| smolagents | 15+17+13+8+7+10+5 | 75 | 一致 |
| AutoGen（历史） | 18+20+15+8+7+8+1 | 77 | 一致 |
| Codex | 20+17+19+15+9+7+5 | 92 | 一致 |
| OpenHands | 18+19+19+14+9+7+5 | 91 | 一致 |
| browser-use | 20+19+17+11+8+8+5 | 88 | 一致 |

这些整数只方便在统一框架下检查“哪些证据改变了判断”。92 与 91、87 与 84 等相邻结果不表示统计显著差异；落在同一锚点档的项目不作严格名次解释。跨层比较尤其应先看任务类型和证据理由，再看总分。
