# 研究附录：Pi 架构、成熟度与演进状态（2026-08-11）

## 研究范围

本文研究对象为官方仓库 [`earendil-works/pi`](https://github.com/earendil-works/pi)。材料来自固定提交源码、官方文档、GitHub API、npm registry 与发布记录。

需要区分两个成熟度差异很大的对象：

1. 现役 Pi coding-agent 产品及其 `pi-ai`、`Agent`、`AgentSession`、`SessionManager`；
2. 正在演进的 durable `AgentHarness`。

二者不能混合评价。现役 coding-agent 已经是成熟度较高的本地开发工具；durable `AgentHarness` 仍属于规格、存储层与脚手架阶段。

## 证据快照

- 稳定发布：[`v0.84.1`](https://github.com/earendil-works/pi/releases/tag/v0.84.1)，发布于 2026-08-07，对应提交 [`53fa77c`](https://github.com/earendil-works/pi/tree/53fa77ccd8a279eb87e92294ef3687b03ff80112)。
- 最后检查的 main：[`75c7fd6`](https://github.com/earendil-works/pi/tree/75c7fd6623f19a1331d27d6ac0060d8bce890c84)，2026-08-11。
- npm 最新包：[`@earendil-works/pi-coding-agent@0.84.1`](https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/latest)，MIT license，带 provenance attestation。
- npm 官方下载 API 显示 2026-07-11 至 2026-08-09 下载量为 **6,040,652**；该数字包含安装和 CI 流量，不等于独立用户数。[官方 API](https://api.npmjs.org/downloads/point/2026-07-11:2026-08-09/%40earendil-works%2Fpi-coding-agent)
- GitHub 仓库 API 在检查时显示约 **87k stars、10.8k forks**，仓库仍在活跃更新。[官方 API](https://api.github.com/repos/earendil-works/pi)

## 现役架构

```text
pi-ai
  provider / model / auth / stream 协议统一层
      ↓
pi-agent-core Agent
  进程内 tool loop、事件流、steering / follow-up 队列
      ↓
pi-coding-agent AgentSession
  extensions、自动重试、compaction、工具与交互生命周期
      ↓
SessionManager + TUI / print / JSON / RPC / SDK
  JSONL 树形 session、分支、恢复历史与产品界面
```

### `pi-ai`

`pi-ai` 把 provider 定义为同时拥有 model catalog、认证与 stream 行为的运行时单元，而不只是 URL adapter。官方实现覆盖 OpenAI、Anthropic、Google、Vertex、Bedrock、GitHub Copilot、OpenRouter、xAI、Mistral、DeepSeek、Groq、Cloudflare、Hugging Face、Moonshot/Kimi、Qwen 等，并支持 OpenAI-compatible API。[provider 列表](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/ai/README.md#supported-providers)

这一层还负责 provider-owned auth、模型目录刷新、reasoning/thinking 兼容映射、跨 provider 历史转换、wire protocol lazy loading，以及 token、cache 与 cost 统一记账。

### `pi-agent-core Agent`

低层 [`runLoop`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/agent-loop.ts) 有内外两层循环：内层处理 tool continuation 与 steering，外层在 Agent 准备停止时消费 follow-up。完整 Agent history 会先经过 `transformContext` 和 `convertToLlm`，因此内部历史与 provider 可见视图可以分离。

工具并发执行保留了明确的顺序语义：

- 参数验证和 `beforeToolCall` preflight 按模型原始顺序执行；
- 获准的 sibling tools 可以并发；
- completion event 可以按实际完成顺序出现；
- 最终 tool-result messages 仍按 assistant source order 回填；
- 任一工具声明 `executionMode: "sequential"` 时，整批降级为顺序执行；
- 模型输出被截断时，不执行可能带有不完整参数的 tool calls。

### 现役 CLI

CLI 入口明确使用 `main.ts with AgentSession`。`main.ts` 创建或打开 `SessionManager`，加载 trust、settings、providers、extensions 与 skills，再通过 `createAgentSessionFromServices()` 和 `createAgentSessionRuntime()` 建立运行时。[CLI 入口](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/cli.ts#L1-L10) [main 创建链](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/main.ts#L668-L849)

`AgentHarness` 当前主要通过 coding-agent 的 experimental server 路径接入，不是主 CLI 的默认控制流。[构造桥接](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/server/create-harness.ts#L78-L158)

## Session tree 与 compaction

现役 `SessionManager` 使用 JSONL。header 后的 entries 通过 `id/parentId` 构成树，消息、模型切换、thinking level、compaction、branch summary、label 与 extension state 都是不同 entry 类型。[session format](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/session-format.md)

- `/tree` 在同一 session 文件内移动 active leaf；
- `/fork` 和 `/clone` 创建新的 session 文件；
- branch summary 保存离开旧分支时的重要信息；
- extension state 可以随分支重建；
- 完整 canonical history 与模型接收的当前分支投影相互分离。

Compaction 会选择 cut point、生成结构化摘要并追加 `CompactionEntry`。旧 entries 不会删除；provider 输入改为 summary + retained tail。工具调用与 tool result 的配对也被纳入切分规则。[compaction 文档](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/compaction.md)

这类机制提供的是 transcript durability。它不等于未完成 operation 的持久化，也不能保证进程在 provider stream 或外部工具副作用中途终止后，从原 effect boundary 精确恢复。

## Extensions、skills 与 subagents

Pi 的核心策略是保持 core 较小，把工作流放进 TypeScript extensions。扩展可以注册或覆盖 tools、commands、renderers、keybindings、UI 与 providers，并在 input、context、provider request/response、tool call/result、compaction 和 session switch 等边界拦截运行。[extensions 文档](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/extensions.md#events)

Skills 采用 progressive disclosure：启动时只把 name/description 放进 system prompt，匹配后再读取完整 `SKILL.md`；同时兼容 `.agents/skills`、Claude Code 与 Codex 的 skills 目录。[skills 文档](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/skills.md)

Subagent 不是内置运行时原语。README 明确说明 Pi 默认不内置 subagents 和 plan mode，而是交给 extensions 或第三方 packages。[coding-agent README](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/README.md#L15-L19)

官方 subagent example 通过独立 `pi` 子进程运行隔离上下文，支持 single、parallel 与 chain，再把最终输出作为父 Agent 的 tool result。它证明了扩展面的能力，但不属于 core 的一等多 Agent 兼容合同。[subagent example](https://github.com/earendil-works/pi/tree/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/examples/extensions/subagent)

## 安全边界

Pi 没有内建通用 permission system，也没有内建 sandbox。read、write、edit、bash 与 extensions 默认继承启动用户的权限。

Project trust 只控制是否加载项目本地 settings、extensions、skills 和 packages，不限制模型在会话开始后可以请求工具执行什么。官方建议在 Docker、VM、Gondolin micro-VM 或 OpenShell 中运行不可信或无人监督任务。[security](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/security.md#L1-L53) [containerization](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/containerization.md)

因此，Pi 的默认安全模型是 trusted-local harness，而不是内建安全内核。Extension hooks 可以实现 permission gate，但强隔离边界需要由操作系统、容器或虚拟化层提供。

## Durable `AgentHarness`

[`harness-v3.md`](https://github.com/earendil-works/pi/blob/75c7fd6623f19a1331d27d6ac0060d8bce890c84/packages/agent/docs/harness-v3.md) 描述了比现役 CLI 更强的模型：

- conversation tree 与 named lanes；
- 每 lane 最多一个 durable operation；
- entries、registers、usage ledger 三类 durable store；
- durable program counter；
- provider/tool effect 的 intent → effect → settlement sandwich；
- replay-safe 与 replay-never tool 区分；
- crash 后恢复原 operation；
- manual drive 在 effect boundary 停车，用于确定性 crash testing；
- 单 writer、atomic transaction、storage backends 与 telemetry。

但截至本次快照：

- 文档状态仍为 `complete, pending final audit`；
- main 仍保留 `harness-v3-audit-findings.md`；
- `AgentHarness.create()` 遇到已有 operation records 会抛出 `HarnessNotImplemented("create.restore")`；
- `prompt`、`resume`、`abort`、`compact`、`navigateTree`、`steer`、`followUp`、`executeAction`、`watch` 与 `lanes` 等公共路径仍是 stub；
- 现役 CLI 继续使用 `AgentSession + SessionManager`。

直接源码证据见 [`agent-harness.ts`](https://github.com/earendil-works/pi/blob/75c7fd6623f19a1331d27d6ac0060d8bce890c84/packages/agent/src/harness/agent-harness.ts#L347-L451)。

因此，v3 当前属于架构规格和未完成实现，不能用它证明 Pi 已经具备 durable lanes、crash-safe resume 或 exactly-once external effects。该规格也明确把 exactly-once external effects 列为 non-goal。

## 工程成熟度

积极信号：

- 发布源码中约有 440 个测试或 eval 文件，覆盖 provider 转换、认证、tool loop、parallel execution、compaction、session branching、extensions、RPC/client/server、telemetry 与 harness scaffold；
- CI 执行 build、format/lint、type check 与 tests；
- release workflow 构建多平台 binary、校验 SHA256，再发布 npm 与 GitHub assets；
- 直接依赖固定版本，CLI 使用 shrinkwrap，npm 包带 provenance attestation；
- 发布频繁，provider 与跨平台兼容问题持续修复。

风险信号：

- 仍处于 `0.x`，近期 release notes 包含显著 breaking changes；
- server/client 与 durable harness 的公共 API 仍在快速变化；
- 新 contributor 的 issue/PR 默认 auto-close 后再由维护者复核，社区入口治理较强；
- durable operation recovery 尚未成为现役产品能力。

## 综合成熟度判断

| 层次 | 当前状态 |
|---|---|
| coding-agent 用户产品 | 成熟度高；适合受监督的本地日常开发 |
| provider、tool loop、session tree、extensions | 实现完整度高，但仍处于快速变化的 `0.x` 发布阶段 |
| security boundary | project trust 可控制项目资源加载；没有内建 sandbox，强隔离必须外置 |
| server/client 与远程运行 | 已有实验性实现，公共 API 尚不稳定 |
| durable `AgentHarness` | 规格与存储模型先进，关键 operation 与 restore 尚未完成 |

## 与其他公开样本的机制比较

| 对照样本 | 共同点 | Pi 的主要差异 |
|---|---|---|
| [smolagents](../agents/01-smolagents.md) | 都有 model → tool → result → next turn 的显式循环 | Pi 增加 streaming events、steering/follow-up、parallel preflight 与稳定回填顺序，产品表面积更大 |
| [OpenAI Agents SDK](../agents/02-openai-agents-sdk.md) | 都有 hook、tool loop、session 与运行队列 | Pi 没有同等成熟的一等 handoff/HITL `RunState`；差异化集中在 extension architecture 与树形 session |
| [Codex](../agents/05-codex.md) | 都是本地 coding agent，都有 tools、skills、compaction 与 steering | Pi 采用“默认继承用户权限 + 外置容器/扩展”，Codex 则内建授权与隔离编排 |
| [OpenHands](../agents/06-openhands.md) | 都有交互界面、进程外协议、会话状态与扩展面 | Pi 更小、更 extension-first；OpenHands 的事件恢复、Workspace 与资源锁更完整 |
| [OpenWorker](../agents/07-openworker.md) | Pi v3 spec 同样讨论 durable operation 与 replay policy | 现役 Pi 尚无完整 durable human-attention control plane，v3 仍不能代表产品现状 |

Pi 最有辨识度的机制集中在三个方面：

- 小核心与大型 TypeScript extension/event API；
- canonical session tree 与 provider context projection 的分离；
- 从 transcript durability 向 operation durability 演进时暴露出的 effect intent、settlement 与 replay policy 问题。

## 后续观察条件

以下变化会显著改变对 durable runtime 成熟度的判断：

1. `AgentHarness` 的 `prompt`、`resume`、`compact`、`navigateTree` 等关键 operation 完整实现；
2. `create.restore` 和 suspended operation resume 可实际运行；
3. CLI 或 server 的默认控制流采用 `AgentHarness`，而不只是保留构造桥接；
4. crash matrix 覆盖 provider stream、parallel tools、unsafe replay、abort 与 storage failure；
5. 公共 API 至少经过一个相对稳定的发布周期。

在这些条件满足前，对 Pi 最准确的描述是：**一个已经很强、很流行、很可塑的本地 coding-agent 产品，正在设计一套远比现役 session runtime 更耐久的下一代 harness；产品现状与下一代设计必须分开评价。**
