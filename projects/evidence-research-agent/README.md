# Evidence Research Agent

这是一个以学习 Agent 工程为目的的本地 TypeScript 项目。当前完成到 Issue #7：一条已经 durable Plan Approval 的 Run 可以由 Scripted Model 驱动真正有界的多轮 Research Loop，经 Harness 调度五个模型可见 Research Tools；Model 与 `search_sources` 的物理 attempts、失败分类和有界 retry 也进入 canonical Journal。研究显式完成后，Run 再通过 Evidence Gate、精确 publication approval 和 no-clobber publisher 产出 Learning Artifact。

当前 Research Loop 已包含 `search_sources`、`read_source`、`record_evidence`、`propose_claim` 与 `complete_research`，并支持对显式标记的基础设施瞬时失败执行有界 retry。它仍不包含 live model、并行 tool batch、预算扩展恢复、`read-source` CLI 或 publication CLI；这些属于后续 tickets。

## 快速开始：创建并批准计划

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

计划审批是跨进程可恢复且幂等的。其 binding 覆盖 question、不可变 plan artifact、完整 Source Scope、Run Budget，以及显式启用时的 Retry Policy；模型输出、Research Tool 参数、环境变量或调用方自造 Receipt 都不能替代用户命令。Retry Policy 会改变自动执行外部调用的上限，因此它是 durable Run fact，而不是重启进程可以偷偷替换的本地选项。

## 运行有界多轮 Research Loop

`advanceResearch` 是 Issue #6 的主 seam。每轮先从 canonical Journal/Projection 和批准 plan artifact 重建 Model View；模型返回完整 Model Turn 后，Harness 才逐项验证并调度 intents。下面以 Scripted Model 展示确定性的三轮最短路径，完整五工具示例见 `tests/runtime/research-loop.test.ts`。

```ts
import { ResearchAgentRuntime, ScriptedModel } from "./src/index.js";

const model = new ScriptedModel(
  [],
  [],
  [
    {
      text: "读取已知来源。",
      evidenceGaps: ["需要冻结精确来源版本"],
      finishReason: "tool_calls",
      toolIntents: [{
        intentId: "read-1",
        name: "read_source",
        input: {
          rootIndex: 0,
          relativePath: "adr/0003-use-run-journal-and-derived-projections.md",
          startLine: 1,
          endLine: 3,
        },
      }],
    },
    // 后续 turns 从 observation 中取得 sourceObservationId / evidenceId，
    // 再调用 record_evidence、propose_claim，最后 complete_research。
  ],
);

const runtime = ResearchAgentRuntime.open({ runtimeHome: ".runtime", model });
const result = await runtime.advanceResearch({
  runId: "<approved-run-id>",
  steering: "优先验证 Journal 与 Projection 的恢复关系。",
});
console.log(result.state.type); // research_complete 或 budget_exhausted
runtime.close();
```

Model View 固定包含批准计划、approval binding、预算版本与余额、未决 evidence gaps、pending intents 和最新 steering。旧 observations 与 Evidence 按确定性顺序裁剪；若 pinned facts 本身仍放不下，Runtime 抛出 `ModelViewTooLargeError`，不会请求 LLM 自动摘要或静默删除约束。

## 配置并观察有界 retry

只有 adapter 显式抛出 `InfrastructureFailureError` 时，Harness 才把失败解释为可自动 retry 的基础设施瞬时错误；未知 Model 错误、Model Turn schema 错误和普通 Search 错误不会被偷偷重写成 transient。Retry Policy 在 `run_created` 时冻结并进入计划审批 binding，重启后从 Journal 恢复。

```ts
import {
  InfrastructureFailureError,
  ResearchAgentRuntime,
} from "./src/index.js";

const runtime = ResearchAgentRuntime.open({
  runtimeHome: ".runtime",
  model,
  retryPolicy: {
    version: "retry-v1",
    modelMaxAttempts: 3,
    toolMaxAttempts: 2,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
  },
});

// ModelPort / SourceSearchPort 可显式提供稳定 code 与 provider 最短等待。
throw new InfrastructureFailureError("rate_limited", { retryAfterMs: 2_000 });
```

每个外部调用前先追加 `operation_attempt_started`；失败后追加带 duration、规范 failure、实际 retry delay 的 `operation_attempt_failed`。成功 Model Turn 或 Search observation 与成功 attempt 在同一 SQLite transaction 提交。attempt 上限耗尽进入 suspended `retry_exhausted`；Model contract、未知永久错误或可持久化 invariant violation 进入 terminal `failed`。Search 普通执行失败则形成 `tool_execution` observation，保留给下一轮模型，不会不加区分地终止整个 Run。

## 从来源到 Learning Artifact 的显式 TypeScript API

Issue #5 的显式命令仍从 TypeScript public seam 暴露，方便独立学习每一个边界。Research Loop 内部复用同一 source/evidence/claim 领域规则，并不会绕过 reducer、SQLite 或 Evidence Gate。

```ts
import { resolve } from "node:path";
import { ResearchAgentRuntime } from "./src/index.js";
import type { ModelPort } from "./src/index.js";

// 真实适配器只能选择 request.claims 中已有的 ID；这里用小型确定性 adapter
// 让示例不依赖某一个 fixture 的随机 Claim identity。
const model: ModelPort = {
  proposePlan: async () => {
    throw new Error("这个示例从已批准 Run 重启，不会请求新计划");
  },
  proposeLearningArtifact: async (request) => ({
    title: "Run Journal 的可恢复性",
    summary: "以下 Claim 的 citation 由 Runtime 从结构化 Evidence 渲染。",
    claimIds: request.claims.map((claim) => claim.claimId),
  }),
};
const runtime = ResearchAgentRuntime.open({
  runtimeHome: ".runtime",
  outputRoot: resolve("learning-artifacts"),
  model,
});

try {
  const afterRead = await runtime.readSource({
    runId: "<approved-run-id>",
    request: {
      rootIndex: 0,
      relativePath: "adr/0003-use-run-journal-and-derived-projections.md",
      startLine: 1,
      endLine: 12,
    },
  });
  if (afterRead.state.type !== "researching") throw new Error("unexpected state");
  const observation = afterRead.state.sourceReadObservations.at(-1);
  if (observation?.status !== "succeeded") throw new Error("source was not captured");

  const withEvidence = await runtime.recordEvidence({
    runId: afterRead.runId,
    observationId: observation.observationId,
  });
  if (withEvidence.state.type !== "researching") throw new Error("unexpected state");
  const evidence = withEvidence.state.evidenceRecords.at(-1);
  if (evidence === undefined) throw new Error("evidence was not recorded");

  await runtime.recordClaim({
    runId: afterRead.runId,
    kind: "source_fact",
    text: "Run Journal 是可恢复状态的 canonical history。",
    evidenceIds: [evidence.evidenceId],
  });

  const waiting = await runtime.proposeLearningArtifact({
    runId: afterRead.runId,
    // 必须在 Output Root 内；Runtime 会冻结 root、canonical path 与 parent identity。
    targetPath: resolve("learning-artifacts/run-journal.md"),
  });
  if (waiting.state.type !== "waiting_publication_approval") {
    throw new Error("draft was not gated");
  }

  const ready = await runtime.approvePublication({
    runId: waiting.runId,
    bindingHash: waiting.state.publicationBinding.bindingHash,
  });
  if (ready.state.type !== "ready_to_publish") throw new Error("not approved");

  const completed = await runtime.publishLearningArtifact({
    runId: ready.runId,
  });
  console.log(completed.state);
} finally {
  runtime.close();
}
```

为了独立学习完整 happy path，可运行：

```bash
pnpm exec vitest run tests/runtime/learning-artifact-publication.test.ts
```

## 关键不变量

- `advanceResearch` 每次都从 Run Journal、Projection 与批准 plan artifact 重建 Model View；Model View 不是 Journal，也不是完整 `messages[]`。完整 Model Turn 先 durable append，pending intents 再由 Harness 顺序消费，重启后不会要求模型猜测未决动作。
- Model/search 外部 I/O 前必须先 durable 提交 `in_progress` attempt。重启看到未完成 attempt 时，会先持久化 `model_turn_interrupted` 或 `search_interrupted`，然后只在冻结 policy 允许时重试；已原子提交的成功 attempt/Model Turn/observation 不重新执行。Search 的多个物理 attempts 共享一个 `toolCallId`，因此 retry 不伪造成额外逻辑 Tool Call。
- provider retry hint 是最短等待，不会被 Harness backoff cap 截短；等待和 attempt 都消耗 Research Loop wall time。等待若已经耗尽已批准 wall-time，Runtime 会在下一次外部 I/O 前进入 `budget_exhausted`。
- Run Trace 对 Model contract、Model permanent、permission denial、stale state、ordinary tool execution、infrastructure transient 与 invariant violation 使用稳定、无秘密的 failure category/code；attempt 还暴露 operation kind、序号、结果、duration、policy version 和 retry delay。
- 五个模型可见工具之外的 approval、budget change、publication、shell 与任意写入都不进入 `ResearchToolIntent` 联合。参数 schema 错误、Source Scope denial、stale observation 和普通工具失败都会形成安全 observation，进入下一轮视图。
- Run Budget 由 Harness 与 reducer 共用一个 domain calculator 从 canonical facts 计算：计划 generation、Research Loop turns、Research Tool calls、不同 Source Snapshot、完整 source bytes 与 Research Loop wall time 分别记账。完成工具会在自己的 durable `completedAt` 再检查 Model Turn/wall time，并把该时间冻结为 Research Loop 计费终点；之后的用户空闲或重复 inspect/advance 不会追溯耗尽预算。任何硬维度耗尽都会 durable 进入带 `incomplete` 或 `research_complete` provenance 的 `budget_exhausted`，该状态不能生成 draft 或伪装为可发布完成。
- `search_sources` 通过可注入 `SourceSearchPort` 使用默认固定参数 `rg` adapter；它在启动搜索前复核批准 root identity，并把 extensions、exclusions、共享 secret discovery globs 与 file-size bound 下推到 discovery，每个返回命中还会再走共享 realpath preflight。完整命中列表进入私有 JSON Artifact，Journal/Trace 只保留引用和数量，下一轮 Model View 再按需校验展开；搜索不会创建 Source Snapshot。
- `readSource` 仍只接受 `{ rootIndex, relativePath, startLine, endLine }`，且只允许 `researching` Run；显式完成后会在文件/CAS I/O 前拒绝新读取。成功读取才会保存完整原始 UTF-8 字节到私有 `source-sha256:<hash>` Snapshot；`denied`/`failed` 只写安全 observation，不创建 Snapshot。
- 一个 Evidence Record 只能逐字段绑定一个现有成功 observation 的 `observationId`、`toolCallId`、Snapshot identity、规范范围和 excerpt hash。一个 Claim 显式标为 `source_fact`，且只能引用当前 Run 已登记的 Evidence IDs。
- Evidence Gate 会拒绝空、未知或重复的 Claim/Evidence 关系，并从 Journal 重算已批准 Run Budget 的 model turns、tool calls、按 Source Snapshot identity 去重的 distinct sources、source bytes 与 wall time。它不通过时不创建 draft artifact、更不会触碰用户 target。
- `ModelPort.proposeLearningArtifact` 只能返回标题、摘要和**既有** Claim IDs 的展示顺序。Markdown renderer 是唯一生成 `【Evidence: <id>】` citation 的地方，并固定输出 `Claims`、`Evidence Index` 与紧凑 `Tool usage`；title、summary 或 Claim 中夹带的预渲染 `【Evidence:` token 会被拒绝，因此模型不能伪造可见引文。
- `outputRoot` 是 Runtime 打开时显式配置、且与 private Runtime Home 不重叠的 canonical 目录。private Markdown draft 的 hash、Output Root identity、canonical target path 和目标父目录 `device`/`inode` 共同构成 publication binding。任何 binding、root 或 parent identity 变化都会使旧 approval 失效。
- normal publish 不覆盖不同既有内容：publisher 使用同目录 `0600` temporary file、fsync 和 atomic hard-link no-clobber publication。已有文件若字节完全一致则幂等成功；final symlink、非文件、不同字节或父目录替换都会 fail closed。

## Journal、Trace 与恢复边界

Run Journal 是 canonical history；Projection cache、Model View 和 Trace 都可丢弃并重建。Trace 按顺序保留 operation attempts、completed Model Turns、轻量工具 observations、来源读取的 observation/tool call/Snapshot、Evidence、Claim、research completion/budget/retry suspension、terminal failure、draft、publication receipt 与最终 Markdown SHA-256；search 行正文只存在于被引用的私有 Artifact，并只在最近 Model View 窗口按需展开。`ResearchLoopLifecycleHooks` 在 attempt started、Model Turn 以及五个 Research Tool 的命名 durable seam 注入中断：attempt started 后的中断证明未完成 I/O 可以跨重启分类并按 policy 恢复；search/read 还覆盖 CAS Artifact/Snapshot 写入后与 Journal 事务提交后；Evidence/Claim/completion 覆盖 Journal commit 前后。成功事实若 SQLite commit 失败，命令只返回稳定错误，Journal 中仍只有 `in_progress` attempt；它不会声称 Model Turn 已持久化。`complete_research` 若在同一时刻暴露预算耗尽，会把 `research_completed` 与 `run_budget_exhausted` 放进一个 SQLite event batch，崩溃无法留下 exhausted 但可发布的单独 `research_complete`。Trace 不包含绝对来源路径、私有 Runtime Home、search 行正文、provider payload 或 OS 错误。

`publication_approved` 只表示用户授权了精确 draft/target，状态为 `ready_to_publish`。重启不会自动写文件；只有显式 `publishLearningArtifact` 成功返回后才追加 `learning_artifact_published` 并进入 `completed`。如果进程在外部写入尝试和该 Journal 事件之间崩溃，当前实现不会把“文件可能存在”猜成完成；完整 effect crash reconciliation 留给 Issue #14。

Node.js 24 没有可移植的 `openat`/`openat2` 与 `renameat2(RENAME_NOREPLACE)`。来源读取和 target publication 都使用 symlink 拒绝、`O_NOFOLLOW`、file-handle/parent identity 复核，对稳定可观测变化 fail closed；它们不承诺隔离 hostile same-user concurrent rename。

## 学习入口

- `src/application/research-agent-runtime.ts`：public command seam、两层 user approval、Evidence Gate 之前的模型边界与外部 publication 调用点。
- `src/infrastructure/private-source-search.ts`：固定参数 `rg`、root identity 复核、discovery 过滤与逐命中 realpath preflight。
- `src/domain/reducer.ts`：追加 Journal 如何确定性派生 Evidence/Claim/draft/approval/completed 状态，并重新验证所有关联。
- `src/domain/evidence-gate.ts` 与 `src/domain/learning-artifact.ts`：结构化引文授权和 deterministic Markdown renderer。
- `src/infrastructure/private-source-access.ts`：canonical Source Scope、handle 读取与 Snapshot 前的 policy boundary。
- `src/infrastructure/sqlite-run-store.ts`：Journal、Projection cache、Source Snapshot registry 与通用 artifact registry 的事务对应关系。
- `src/infrastructure/learning-artifact-publisher.ts`：target identity、same-directory no-clobber atomic publication 与不同内容拒绝。
- `tests/runtime/learning-artifact-publication.test.ts`：ScriptedModel happy path、Gate、target identity、direct replay tamper 与 Trace lineage。
- `tests/runtime/research-loop.test.ts`：五工具多轮 happy path、重启后 pending intent 恢复、search port/artifact 边界、replay 防篡改、错误 observation、五维预算暂停、steering/pinned Model View 与确定性裁剪。
- `tests/runtime/retry-policy.test.ts`：Model/Search transient retry、provider hint、attempt lineage、policy approval/restart、崩溃恢复、普通失败、schema/permanent/invariant failure、wall-time 与 SQLite commit failure。
- `docs/architecture.md`：组件图、状态机、publication effect 的明确恢复边界。

## 尚未实现

- Issue #8：Vercel AI SDK `streamText` 驱动的 OpenAI-compatible live Model Port；SDK 类型仍必须隔离在 `ModelPort` 后。
- Issue #9：用户暂停、取消、预算版本扩展与从 `budget_exhausted` 精确恢复。
- Issue #11：安全 search/read sibling batch 的有界并发与模型原始顺序回填。
- Issue #14：publication 外部 effect 的 durable operation、crash reconciliation 与精确恢复协议。
