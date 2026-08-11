# Evidence Research Agent

这是一个以学习 Agent 工程为目的的本地 TypeScript 项目。当前完成到 Issue #3 的 versioned plan approval slice：

1. 用户提交一个技术问题和 Source Scope。
2. `ResearchAgentRuntime` 追加 `run_created` 与 `planning_started`。
3. `ScriptedModel` 通过 `ModelPort` 返回完整计划。
4. 计划写入内容寻址 Artifact Store，Journal 追加 `plan_proposed`。
5. Runtime 将问题、计划、Source Scope 与 Run Budget 绑定为用户可见的 `bindingHash`，Run 持久停在 `waiting_plan_approval`。
6. 独立 `approve-plan` 用户命令原样提交该 hash，Journal 追加完整 Approval Receipt 并派生出 `researching`。

当前版本刻意不使用 Vercel AI SDK。它将在 Issue #8 中作为 live model adapter 引入，并被隔离在 `ModelPort` 后面；这样本 ticket 可以先证明 Harness、持久化和恢复语义，而不把模型随机性混进运行时测试。

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

记下输出中的 `runId`，然后可以在任意后续进程读取同一 Runtime Home。审批前用 JSON inspect 取得当前等待版本的精确 `bindingHash`：

```bash
node dist/src/cli.js inspect --runtime-home .runtime --run-id <run-id> --json
```

在输出的 `state.approvalBinding.bindingHash` 中复制完整值，并原样回显给独立审批命令：

```bash
node dist/src/cli.js approve-plan \
  --runtime-home .runtime \
  --run-id <run-id> \
  --binding-hash <state.approvalBinding.bindingHash> \
  --json

node dist/src/cli.js trace --runtime-home .runtime --run-id <run-id> --json
```

这个聚合 binding 同时覆盖原始 question、不可变 plan artifact、完整 Source Scope，以及 Run Budget 的 `version` 与内容 hash。它不是可缩写的确认码：格式错误会被判为 malformed command；合法的 64 位 hash 若不匹配当前等待版本，则被判为 stale approval，两类错误都不会回显提交值或受保护 payload。模型输出、Research Tool 参数、环境变量和调用方自造 Receipt 都不能代替用户命令。

审批是跨进程可恢复且幂等的：关闭创建 Run 的进程后，仍可从同一 Runtime Home 审批；相同 `runId` 与 `bindingHash` 的重复命令会返回同一个 durable Projection，`lastEventSequence` 保持为 4，不会生成第二份 Receipt。此时 `researching` **只表示精确计划审批已经持久化**；直到 Issue #4 才会读取私有 Source Snapshot 或执行 Research Tool。

`.runtime/` 是私有运行状态，已在仓库根 `.gitignore` 中忽略；它不是发布目录，也不应保存凭据。

## 学习入口

- `src/application/research-agent-runtime.ts`：command-oriented 主 seam、审批幂等边界，以及外部模型调用不占用 SQLite 事务的原因。
- `src/domain/reducer.ts`：Journal event 到 Run Projection 的唯一合法状态转换入口。
- `src/infrastructure/sqlite-run-store.ts`：追加式 Journal、expected-sequence 并发保护，以及同事务 Projection cache。
- `src/infrastructure/content-addressed-artifact-store.ts`：不可变计划内容和摘要完整性检查。
- `src/adapters/scripted-model.ts`：消除 live model 方差的确定性 Model Port。
- `tests/runtime/plan-approval.test.ts`：真实临时 SQLite 上的 exact binding、Receipt、幂等与跨进程恢复测试。
- `tests/cli/cli.test.ts`：新进程式 CLI 创建、inspect、审批、重复审批与安全错误测试。
- `tests/documentation/field-docs.test.ts`：逐字段 TSDoc 的正向、负向和全项目审计。
- `docs/architecture.md`：组件/端口图、Run 状态机和核心不变量。

## 设计边界

- Run Journal 是 canonical history；Projection 和 Trace 都可重建。
- Model SDK、SQLite 类型和文件系统细节不进入公共 runtime command。
- 当前 `run` CLI 使用通用的 `ScriptedModel` 计划；`inspect`、`approve-plan` 与 `trace` 使用空脚本模型，证明恢复路径不重采样。这不代表 live model 能力。
- Source Scope 在当前 ticket 中被验证、冻结并纳入审批 binding；realpath containment、Source Snapshot 和真实源读取属于 Issue #4。
- Model 失败会留下可 inspect 的 `planning` 状态；正式失败分类和恢复命令属于 Issue #7。
