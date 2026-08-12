# Issue #15 毕业验收矩阵

本矩阵把 GitHub Issue #15 的 acceptance criteria 映射到可重复执行的证据。默认可靠性结论只来自 deterministic suite：真实 SQLite、私有 CAS、Scripted boundaries、可控 clock/IDs，并从 `ResearchAgentRuntime` 公共 seam 观察 Run Journal 派生的 Projection/Trace。真实模型 eval 单独运行，只证明指定模型与版本化 fixture 的兼容性，不替代 fault tests。

## Fault matrix

| 边界 | 关键前/后故障与恢复结论 | 主要证据 |
| --- | --- | --- |
| Journal / Projection transaction | event 与 artifact/snapshot registry 原子提交；缓存可从 Journal 重建；commit failure 不虚报 completed fact | `tests/runtime/research-agent-runtime.test.ts`、`tests/runtime/source-read.test.ts`、`tests/runtime/retry-policy.test.ts` |
| Approval consumption | plan 与 publication Receipt 在 commit 前中断时不被消费；commit 后中断时保留 exact Receipt，重复命令返回同一 Projection 且不追加第二个 approval event | `tests/runtime/plan-approval.test.ts`、`tests/runtime/learning-artifact-publication.test.ts` |
| Model stream / Model Turn | partial stream 在 cancel/error 时不进入 Journal；completed Model Turn commit 前可重试，commit 后不重采样；usage 与 Experiment Identity 只在完整结果后持久化 | `tests/runtime/live-model-port.test.ts`、`tests/runtime/research-loop.test.ts`、`tests/runtime/retry-policy.test.ts` |
| Research Tool lifecycle | search/read 的 CAS-before-Journal 与 Journal-after-commit 边界、Evidence/Claim/completion 的 commit 前后边界均可重启恢复；已提交 intent 不重复执行 | `tests/runtime/research-loop.test.ts` |
| Run Operation lease | 同 Run mutation 互斥、read-only 与不同 Run 可并行；heartbeat、expiry、takeover 与 stale-owner fencing 不代替业务事实 | `tests/runtime/run-operation.test.ts` |
| Cancel request | durable request 可跨 requester/owner 崩溃被下一命令消费；stream、pending tool、completed result 与 completion race 都保持 terminal cancellation 语义 | `tests/runtime/run-control.test.ts`、`tests/runtime/run-operation.test.ts` |
| Parallel reads | sibling search/read 只在顺序 preflight 后并发；真实完成顺序进入 Journal，而 Projection/Model View 恢复模型 intent 顺序；预算 reservation 与 retry 各自隔离 | `tests/runtime/research-loop.test.ts` |
| Evidence Gate | Source Snapshot bytes、range、excerpt hash、tool-call lineage、Claim classification、预算与 approval 由 deterministic Gate 重算；失败进入 typed repair，不由 evaluator 覆盖 | `tests/runtime/evidence-gate.test.ts`、`tests/runtime/learning-artifact-publication.test.ts`、`tests/runtime/research-loop.test.ts` |
| Rename / path identity | Source Root、parent、final symlink、device/inode、realpath 与 no-clobber target 在关键 I/O 前后复核；稳定可观测替换 fail closed | `tests/runtime/source-scope-canonicalization.test.ts`、`tests/infrastructure/private-source-access.test.ts`、`tests/infrastructure/learning-artifact-publisher.test.ts` |
| Publication Effect / reconcile | PENDING、EXECUTING、UNKNOWN、CONFLICT、SUCCEEDED 的 prepare、temporary write、atomic publish、settlement 与 reconciliation 前后边界均保留稳定 effect identity；matching 不重写、missing 可安全重试、different 永不覆盖 | `tests/runtime/learning-artifact-publication.test.ts`、`tests/cli/cli.test.ts` |

## Acceptance criteria 映射

| Issue #15 acceptance criterion | 实现/文档 | 验证证据 |
| --- | --- | --- |
| 新 Runtime 从同一 Runtime Home 重建全部测试 Run，completed Model Turn、tool call、Publication Effect 不盲目重跑 | Run Journal canonical、Projection rebuild、pending intent recovery、explicit reconciliation | 上述 Model/Tool/Publication 行；`pnpm check` |
| fault matrix 覆盖 transaction、approval、stream、tool、lease、cancel、parallel、Gate、rename、reconcile | 本文件的 fault matrix；命名 lifecycle hooks | `tests/runtime/**` 与 `tests/infrastructure/**` |
| realpath/symlink/secret/binary/size、approval invalidation、预算恢复、取消竞态、lease expiry、并行顺序、evidence lineage | Source policy、approval binding、Run Budget extension、cancel control plane、deterministic scheduler、Claim/Evidence model | `private-source-access.test.ts`、`source-scope-canonicalization.test.ts`、`run-control.test.ts`、`run-operation.test.ts`、`research-loop.test.ts`、`learning-artifact-publication.test.ts` |
| 固定 fixture 重复运行真实 OpenAI-compatible model，并记录 identity、budget、cost、latency、verdict | `evals/fixtures/local-journal-plan-v1.json`、`evals/results/local-journal-plan-v1.json` | `pnpm build && pnpm eval:live`；已记录 Ollama `qwen3-coder:30b` 2/2 pass |
| live eval 与 deterministic suite 分离，不依赖一次成功或 LLM judge | `eval:live` 不在 `check` 中；verdict 为 deterministic plan contract | `tests/evals/live-plan-eval.test.ts`、`package.json` |
| TypeScript 对象字段逐字段 TSDoc；中文注释解释不变量/取舍/失败路径 | 自动字段审计覆盖项目 `.ts/.tsx`；人工复核 runtime/CLI/eval 新控制流 | `tests/documentation/field-docs.test.ts`；code review |
| 组件/端口、状态机、Claim/Evidence lineage、Publication Effect Mermaid 与代码一致 | `docs/architecture.md` 四幅图 | `tests/documentation/mermaid.test.ts` |
| CLI 可创建、审批、推进、检查、trace、暂停、恢复、取消、publication approval、publish、reconcile | `run`、`approve-plan`、`advance`、`inspect`、`trace`、`operation`、`pause`、`resume`、`cancel`、`extend-budget`、`propose-artifact`、`retry-evaluator`、`skip-evaluator`、`approve-publication`、`publish`、`reconcile` | `tests/cli/cli.test.ts` 的 process-like graduation、isolated control、publish 与 crash-reconcile fixtures |
| README 说明运行边界、配置、学习顺序、限制与未解决安全/一致性问题 | `README.md` | 文档审查与 `pnpm docs:check` |

## 验收命令

```bash
pnpm check
pnpm build
```

真实模型证据是显式、可选、独立运行：

```bash
EVIDENCE_MODEL_PROVIDER=ollama \
EVIDENCE_MODEL_BASE_URL=http://127.0.0.1:11434/v1 \
EVIDENCE_MODEL_API_KEY=ollama-local \
EVIDENCE_MODEL_NAME=qwen3-coder:30b \
pnpm eval:live
```

最后一次记录结果为 2/2 trials passed；latency 分别为 16,717 ms 与 4,913 ms。API charge 为 USD 0；本地硬件与电力未计量。adapter 当前没有从 plan generation 暴露 token usage，因此结果明确记录为 `unavailable`，不使用估算值。
