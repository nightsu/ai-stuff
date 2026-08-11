# AI Agent 设计与源码课程（2026）

这是一套以源码为教材的中文课程：从最小 Agent loop 开始，逐步进入状态恢复、领域化 observation、安全执行、完整产品运行时，再把这些机制组合成一个最小可靠 Agent Runtime。多 Agent 与企业编排放在核心实践之后，作为进阶专题。

## 从这里开始

先阅读[学习路线与章节目录](agents/00-learning-guide.md)。下面是兼顾知识依赖与认知负荷的推荐主线，不表示每一章都是后一章的硬前置：

```text
smolagents
  → OpenAI Agents SDK
  → LangGraph
  → browser-use
  → Codex
  → OpenHands
  → OpenWorker
  → 核心综合实践：最小可靠 Agent Runtime
  → CrewAI
  → Microsoft Agent Framework
  → AutoGen（历史与迁移）
```

顺序背后的原则：

1. 先看懂一个 Agent 怎样循环；
2. 再理解状态、暂停与恢复；
3. 然后处理真实副作用、产品状态和人类注意力；
4. 先独立完成一个可靠运行时，再进入多 Agent 与企业 Workflow。

## 正文章节

### 第一部分：Agent 基础

1. [smolagents：最小 ReAct / CodeAct 循环](agents/01-smolagents.md)
2. [OpenAI Agents SDK：生产化 Runner、handoff 与 RunState](agents/02-openai-agents-sdk.md)

### 第二部分：状态与领域闭环

3. [LangGraph：reducer、superstep、checkpoint 与 interrupt](agents/03-langgraph.md)
4. [browser-use：浏览器 observation、action 与恢复](agents/04-browser-use.md)

### 第三部分：安全与产品运行时

5. [Codex：意图、审批、沙箱与执行](agents/05-codex.md)
6. [OpenHands：事件化 Conversation 与 Agent 平台](agents/06-openhands.md)
7. [OpenWorker：耐久 Inbox 与人类注意力控制面](agents/07-openworker.md)

### 核心综合实践

- [设计一个最小可靠 Agent Runtime](14-capstone-agent-runtime.md)

完成第 1–7 章即可进入综合实践。它是主线的收束点，不以多 Agent 知识为前置条件。

### 进阶专题：多 Agent 与企业编排

8. [CrewAI：Crew 组织模型与 Flow](agents/08-crewai.md)
9. [Microsoft Agent Framework：企业 Workflow 与 middleware](agents/09-microsoft-agent-framework.md)
10. [AutoGen：消息型多 Agent 的历史基线](agents/10-autogen-historical.md)

## 怎样使用每一章

每章都围绕一个具体设计问题组织，并包含：

- 本章目标和先修知识；
- 最小架构图；
- 正常路径与失败/恢复路径；
- 固定提交的源码阅读顺序；
- 等价伪代码与关键不变量；
- 可执行练习和掌握标准。

第一次阅读不需要记住框架 API。真正需要带走的是：谁决定下一步、状态由谁持有、失败后重跑什么、副作用如何获权、什么条件才算完成。

## 研究附录

以下材料用于查证和扩展，不应挡在课程入口之前：

- [研究方法与源码冻结协议](00-methodology.md)
- [候选项目与社区快照](01-candidate-pool.md)
- [评分证据账本](02-scoring-ledger.md)
- [跨项目机制比较](10-comparison.md)
- [闭源与部分开源 Agent 专题](11-proprietary-agent-landscape.md)
- [论文与权威资料导读](12-authoritative-literature-guide.md)
- [Pi 架构、成熟度与演进状态](research/pi-architecture-and-maturity-2026-08-11.md)

完成核心实践后，可使用[源码与文献综合参考架构](13-integrated-synthesis.md)复盘各机制之间的关系。

## 证据边界

- 架构结论追踪到固定提交源码或一方资料；
- 教学伪代码是对源码控制流的等价重写，不是上游逐字代码；
- 推荐顺序兼顾知识依赖与认知负荷；硬先修、可跳读支线和研究样本选择分别记录；
- 没有统一运行所有仓库的端到端测试，不把静态测试数量写成现实任务成功率。
