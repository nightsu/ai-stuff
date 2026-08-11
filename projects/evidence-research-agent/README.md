# Evidence Research Agent

这是一个以学习 Agent 工程为目的的本地 TypeScript 项目。当前完成到 Issue #4：Research Run 在 durable Plan Approval 后，可通过公开 application seam `ResearchAgentRuntime.readSource` 明确读取一个批准范围内的本地 UTF-8 文件，留下可恢复的结构化 observation，并把读取时看到的完整精确字节冻结为私有 Source Snapshot。

当前路径是：创建 Run → 生成并持久化计划 → 用户精确批准 → 调用方显式 `readSource` → Journal/Projection/Trace 可恢复。它不是 live-model 自动研究流程，也还没有 `read-source` CLI。

## 快速开始

要求 Node.js 24+ 与 pnpm。

```bash
pnpm install
pnpm check
pnpm build
```

从项目目录创建一个 Run：

```bash
node dist/src/cli.js run \
  --question "追加式 Run Journal 如何驱动派生状态投影？" \
  --source-root "$PWD/../../docs" \
  --runtime-home .runtime \
  --json
```

记下 `runId`，通过 `inspect` 读取 `state.approvalBinding.bindingHash`，再原样提交：

```bash
node dist/src/cli.js inspect --runtime-home .runtime --run-id <run-id> --json

node dist/src/cli.js approve-plan \
  --runtime-home .runtime \
  --run-id <run-id> \
  --binding-hash <state.approvalBinding.bindingHash> \
  --json

node dist/src/cli.js trace --runtime-home .runtime --run-id <run-id> --json
```

审批是跨进程可恢复且幂等的。聚合 binding 精确覆盖 question、不可变 plan artifact、完整 Source Scope，以及 Run Budget 的版本和内容 hash；模型输出、Research Tool 参数、环境变量或调用方自造 Receipt 都不能代替用户命令。

## 通过 public seam 读取来源

`readSource` 目前只从 TypeScript API 暴露。对同一 Runtime Home 中已经 durable approved 的 Run，可以用空 `ScriptedModel` 重新打开 runtime；该命令不会调用模型：

```ts
import { ResearchAgentRuntime, ScriptedModel } from "./src/index.js";

const runId = "<approved-run-id>";
const runtime = ResearchAgentRuntime.open({
  runtimeHome: ".runtime",
  model: new ScriptedModel([]),
});

try {
  const projection = await runtime.readSource({
    runId,
    request: {
      rootIndex: 0,
      relativePath: "adr/0003-use-run-journal-and-derived-projections.md",
      startLine: 1,
      endLine: 12,
    },
  });
  console.log(projection.state);
} finally {
  runtime.close();
}
```

`rootIndex` 是 `SourceScope.roots` 的 zero-based 索引；`relativePath` 必须是相对该 root 的规范 POSIX 路径；`startLine`/`endLine` 是 1-based inclusive，且 Harness 固定限制单次最多 200 行。成功 observation 只返回该范围的 LF 摘录，但 Snapshot 冻结完整文件的原始精确字节，不是摘录或 UTF-8 重编码副本。

可直接运行主 seam 测试学习完整行为：

```bash
pnpm exec vitest run tests/runtime/source-read.test.ts
```

## Snapshot、lineage 与恢复语义

- 成功状态的实际字面值是 `succeeded`；非成功为 `denied` 或 `failed`。Journal 事件名固定为 `source_read_observed`，Run 保持 `researching`，不会因此成为 `completed`。
- 成功 observation 在 Journal 中关联 `observationId`、内部生成的 `toolCallId` 与 `sourceSnapshot.snapshotId`；Trace 安全地投影 `toolCallId`、`observationStatus` 和 `sourceSnapshotId`。Snapshot identity 格式为 `source-sha256:<64-lowercase-hex>`。
- 相同完整字节即使来自不同路径或 Run，也复用同一个 content identity；live file 变化后产生新 snapshot，旧 snapshot 不变。
- 计划使用通用 `artifacts` registry；Source Snapshot 使用独立、不可变的 SQLite `source_snapshots` registry 和 `source-snapshots/sha256/...` CAS namespace。Runtime Home 与 namespace 目录为 `0700`，snapshot 文件为 `0600`。
- Run Journal 是 canonical history；Projection/cache 和 Trace 是派生数据。重启或 `rebuildRunProjection` 只回放 Journal，不重新读取 live source，也不会把后来改变的文件伪装成原 observation。

## Source policy 与非成功结果

创建 Run 时，root 会在 Plan Approval binding 之前冻结为 canonical path + `device`/`inode` identity。每次读取仍重新检查批准 root、相对路径形状、绝对路径与 traversal、逐段 symlink/realpath containment、exclusion、内建 secret denylist、允许扩展名、UTF-8/NUL 文本类型、普通文件类型、单文件大小、Source Scope/Run Budget 累计字节限制，以及固定行范围。

策略拒绝持久化 `status: "denied"` 与稳定 denial code；可归一化的文件系统失败持久化 `status: "failed"` 与稳定 failure code。两者都只记录安全 lineage 和精确 request hash：不创建 Snapshot、不注册 `source_snapshots`、不扩大 Source Scope、不改写调用参数，也不泄漏绝对路径、原始字节或 OS 错误。

preflight/路径发现不持有 Snapshot store capability；当前也尚未实现 `search_sources`。所以“发现路径”不能冻结内容，只有成功的显式 `readSource` 可以。完整控制流与不变量见 [`docs/architecture.md`](docs/architecture.md)。

## 安全边界

Node.js 24 没有可移植的 `openat`/`openat2` 原子路径能力。实现用逐段 symlink 拒绝、`O_NOFOLLOW`、同一 file handle 读取、前后 `fstat` 和 root/path identity 复核，对稳定可观测变化 fail closed；它不能承诺隔离 hostile same-user concurrent rename。`0700` Runtime Home 的本地假设是同一 OS 用户不主动对抗，`0600` snapshot 也不构成同用户进程间的安全边界。

## 学习入口

- `src/application/research-agent-runtime.ts`：公开 command seam、durable approval 检查、显式 `readSource` 与 Journal 提交边界。
- `src/infrastructure/private-source-access.ts`：canonical root/realpath 预检、handle 读取和变化检测。
- `src/domain/source-policy.ts`：reader 与 reducer 共用的 request/path denial 规则。
- `src/infrastructure/content-addressed-artifact-store.ts`：完整精确字节的私有 Source Snapshot CAS。
- `src/infrastructure/sqlite-run-store.ts`：独立 `source_snapshots` registry、Journal 与 Projection cache 的事务不变量。
- `tests/infrastructure/private-source-access.test.ts`：成功 capture、路径/内容/大小拒绝与竞态 fail-closed 测试。
- `tests/infrastructure/private-source-snapshot-store.test.ts`：identity、去重、`0700`/`0600` 和 namespace 完整性测试。
- `tests/domain/source-policy.test.ts`：共享 exclusion/secret/extension policy 的确定性优先级。
- `tests/runtime/source-read.test.ts`：public seam、三种 observation status、snapshot registry、Trace lineage 与跨重启恢复。
- `docs/architecture.md`：Issue #4 组件/端口图、状态机和安全边界。

## 尚未实现

- Issue #5：Evidence Record、Claim、最小 Evidence Gate、draft approval 与 Learning Artifact 发布成功路径。
- Issue #6：真正的 `search_sources`、模型可见 Research Tools 与有界多轮 Research Loop。
- Issue #7：明确错误分类、retry policy、attempt 记录和恢复状态。
- Issue #8：Vercel AI SDK `streamText` 驱动的 live OpenAI-compatible Model Port；SDK 类型仍必须隔离在 `ModelPort` 后。

因此当前 `ScriptedModel` 只是确定性的 Harness/恢复测试边界，不代表 live model、自动工具调度或完整研究能力。
