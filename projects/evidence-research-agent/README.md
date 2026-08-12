# Evidence Research Agent

这是一个以学习 Agent 工程为目的的本地 TypeScript 项目。Issue #15 毕业范围已实现：确定性的 Scripted Model、OpenAI-compatible live adapter、durable Run control、完整 Claim-to-Evidence lineage Gate、独立 Evaluator Review、跨崩溃 Publication Effect，以及覆盖完整运行路径的 headless CLI。

当前 Research Loop 已包含 `search_sources`、`read_source`、`record_evidence`、`propose_claim` 与 `complete_research`，并支持对显式标记的基础设施瞬时失败执行有界 retry。同一 Model Turn 开头连续、已通过顺序 preflight 的 `search_sources` / `read_source` 会按 `safeReadConcurrency` 有界并发；状态型工具仍严格顺序执行。Evaluator 使用单独的 versioned prompt，只看到用户问题、选中 Claims 和各自 cited Evidence 摘录，不接收 Model View、Run Journal 或 Research Loop history。CLI 可以跨进程推进 Research Loop、处理 evaluator resolution、批准并发布 Learning Artifact，以及显式 reconcile 崩溃后的 Publication Effect。

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

如需用真实 OpenAI-compatible provider 生成计划，先通过环境注入配置，再给 `run` 增加 `--live-model`：

```bash
export EVIDENCE_MODEL_PROVIDER="team-gateway"
export EVIDENCE_MODEL_BASE_URL="https://models.example.com/v1"
export EVIDENCE_MODEL_API_KEY="..."
export EVIDENCE_MODEL_NAME="research-model"

node dist/src/cli.js run \
  --live-model \
  --question "追加式 Run Journal 如何驱动派生状态投影？" \
  --source-root "$PWD/../../docs" \
  --runtime-home .runtime \
  --json
```

adapter/prompt/tool schema/evaluator prompt versions 可分别由 `EVIDENCE_MODEL_ADAPTER_VERSION`、`EVIDENCE_MODEL_PROMPT_VERSION`、`EVIDENCE_MODEL_TOOL_SCHEMA_VERSION`、`EVIDENCE_EVALUATOR_PROMPT_VERSION` 覆盖。provider、model 与这些版本作为非秘密 identity 进入 Journal/Trace/binding；base URL、API key、headers 与 provider payload 不持久化。需要模型 generation 的 CLI 命令必须显式给出 `--live-model`；审批、控制、发布与 reconcile 命令从同一 Runtime Home 恢复 durable state，不加载 provider。

## CLI 毕业路径

下面的命令展示完整跨进程边界。每个命令打开 Runtime、执行一个 public command、打印 Projection/Trace 后退出；实际脚本应从前一步 JSON 读取 `runId` 与 binding hash，不能自行构造审批 authority。

```bash
node dist/src/cli.js run --live-model \
  --runtime-home .runtime \
  --question "追加式 Run Journal 如何驱动派生状态投影？" \
  --source-root "$PWD/../../docs" --json

node dist/src/cli.js inspect --runtime-home .runtime --run-id <run-id> --json
node dist/src/cli.js approve-plan --runtime-home .runtime --run-id <run-id> \
  --binding-hash <state.approvalBinding.bindingHash> --json

# 重复 advance，直到 state.type 为 research_complete、等待/暂停或 terminal 状态。
node dist/src/cli.js advance --live-model --runtime-home .runtime \
  --run-id <run-id> --json

node dist/src/cli.js propose-artifact --live-model \
  --runtime-home .runtime \
  --output-root "$PWD/learning-artifacts" \
  --run-id <run-id> \
  --target-path "$PWD/learning-artifacts/run-journal.md" --json

# evaluator failure 时二选一；成功时跳过这一步。
node dist/src/cli.js retry-evaluator --live-model \
  --runtime-home .runtime --output-root "$PWD/learning-artifacts" \
  --run-id <run-id> --json
node dist/src/cli.js skip-evaluator \
  --runtime-home .runtime --output-root "$PWD/learning-artifacts" \
  --run-id <run-id> --json

node dist/src/cli.js approve-publication \
  --runtime-home .runtime --output-root "$PWD/learning-artifacts" \
  --run-id <run-id> \
  --binding-hash <state.publicationBinding.bindingHash> --json
node dist/src/cli.js publish \
  --runtime-home .runtime --output-root "$PWD/learning-artifacts" \
  --run-id <run-id> --json
```

`inspect`、`trace` 与 `operation` 是只读命令。`pause`、`resume`、`cancel`、`extend-budget` 仍作为独立 control commands 使用；若 publish 在 external effect 与 success settlement 之间中断，则改用本文后面的 `reconcile`，不能直接重放 `publish`。

## OpenAI-compatible live Model Port

`OpenAiCompatibleModelPort` 对 `proposePlan`、`generateResearchTurn`、`proposeLearningArtifact` 与 `reviewClaims` 都使用 `streamText` 的一次 generation，并把 completed tool calls 与 provider failure 归一化到项目类型。Evaluator 使用独立 `submit_evaluator_review` schema，verdict 只能是 `supported`、`partially_supported`、`unsupported`、`contradicted` 或 `uncertain`。AI SDK 自带 retry 固定为 0；`AbortSignal` 会中止未完成 stream，partial delta 不会成为 Model Turn 或 Evaluator Review。

```ts
import {
  createOpenAiCompatibleModelPortFromEnv,
  ResearchAgentRuntime,
} from "./src/index.js";

const controller = new AbortController();
const runtime = ResearchAgentRuntime.open({
  runtimeHome: ".runtime",
  model: createOpenAiCompatibleModelPortFromEnv(),
  retryPolicy: {
    version: "retry-v1",
    modelMaxAttempts: 3,
    toolMaxAttempts: 2,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
  },
});

await runtime.advanceResearch({
  runId: "<approved-run-id>",
  abortSignal: controller.signal,
});
```

provider 可能错误地把 request metadata 或 credential 回显到生成内容；adapter 在解析 plan、Model Turn 或 Learning Artifact proposal 前会按精确 API key 字符串拒绝整个 completed result。公开错误只使用稳定分类与代码，不包含 provider message、URL、body 或 credential。

## 独立真实模型 eval

默认 `pnpm check` 只运行 deterministic runtime、infrastructure、CLI 与 documentation suite，不访问网络或本机模型。版本化 live eval 必须先 build，再显式运行：

```bash
EVIDENCE_MODEL_PROVIDER=ollama \
EVIDENCE_MODEL_BASE_URL=http://127.0.0.1:11434/v1 \
EVIDENCE_MODEL_API_KEY=ollama-local \
EVIDENCE_MODEL_NAME=qwen3-coder:30b \
pnpm eval:live
```

固定输入位于 `evals/fixtures/local-journal-plan-v1.json`，结果写入 `evals/results/local-journal-plan-v1.json`。已记录的真实运行使用 `ollama` / `qwen3-coder:30b`、`openai-compatible-adapter-v1`、`evidence-research-prompts-v1`、`research-tools-v2`，2/2 trials 通过 `deterministic-plan-contract-v1`；latency 为 16,717 ms 与 4,913 ms。API charge 为 USD 0，但未计量本地硬件与电力；plan usage 当前由 adapter 记录为 `unavailable`。该结果不使用 LLM judge，也不声称两次成功证明 Runtime 的恢复、并发或安全可靠性——这些结论只来自 fault-injected deterministic suite。

## 独立 Evaluator Review 与 publish-ready report

`proposeLearningArtifact` 先运行 deterministic Evidence Gate，再构造最小 `EvaluatorReviewRequest`。成功 review 会作为私有 JSON CAS Artifact 保存；identity 绑定 evaluator provider/model、prompt version、exact input hash 与 review artifact hash。renderer 只消费 Gate 选中的 Claim/Evidence identities：Conclusion 必须是恰好一句话，Evidence Index 从结构化 lineage 生成，tool usage summary 则分别统计 Journal 中五类 durable Research Tool calls，而不是用选中 Evidence 数量代替工具使用量。

测试边界也保持分离：`ScriptedModel` 只实现 Research Model，`ScriptedEvaluator` 只实现 Evaluator。生产环境仍可显式把同一个同时实现两种 port 的 OpenAI-compatible adapter 作为默认 evaluator，但两次 generation 使用不同的 versioned prompt 与输入上下文。

Evaluator 失败会 durable 进入 `waiting_evaluator_resolution`，并冻结 exact proposal、target、input hash 和 evaluator identity。`retryEvaluatorReview` 只重做同一 review，不重新调用 proposal model；`skipEvaluatorReview` 持久化 `user-command` skip identity，报告明确显示 `Evaluator: skipped`，不会伪造任何 verdict。普通 `resumeRun` 不能越过该等待。

```ts
const waiting = await runtime.proposeLearningArtifact({
  runId: "<research-complete-run-id>",
  targetPath: resolve("learning-artifacts/report.md"),
});

// 若抛出 EvaluatorReviewPendingError：
await runtime.retryEvaluatorReview({ runId: waiting.runId });
// 或由用户明确选择：
await runtime.skipEvaluatorReview({ runId: waiting.runId });
```

publication approval 状态会同时展示已通过的 hard Evidence Gate 摘要与 advisory warnings；receipt 除 exact draft/target 外，还绑定 review artifact hash 或 explicit skip identity hash。真正发布前 Runtime 会再次读取并校验 Source Snapshots 和 reviewed JSON Artifact；任一 CAS bytes 缺失、篡改或 verdict coverage/order 不一致都保持 `ready_to_publish` 并 fail closed。Trace 暴露安全的 evaluator failure、input/model/prompt identity、review artifact 或 skip identity，不包含 prompt 输入正文、provider payload 或 credential。

## Durable Publication Effect 与 reconcile

`publishLearningArtifact` 先把稳定 effect identity 作为 PENDING 写入 Run Journal，再写入 EXECUTING，最后执行同目录 temporary-file + atomic hard-link no-clobber publication。identity 由 Run、approved draft hash 与 canonical target path 派生；重启、missing retry 与 conflict resolution 都复用同一 identity。

进程在 final bytes 可见后、success settlement 前崩溃时，Run 保持 `publication_executing`。恢复必须显式调用：

```bash
node dist/src/cli.js reconcile \
  --runtime-home .runtime \
  --output-root "$PWD/learning-artifacts" \
  --run-id <run-id> \
  --json
```

reconcile 先持久化 UNKNOWN，再重新验证 Publication Approval、CAS Snapshot/review bytes、Output Root 与 target identity：matching target 结算为 `completed` 且不重写；missing target 回到 `publication_pending` 供同 effect retry；different bytes 进入 `publication_conflict` 且绝不覆盖；无法可靠判断则保持 `publication_unknown`。普通 publish 不能从 EXECUTING、UNKNOWN 或 CONFLICT 盲目重放。PENDING 尚未声明 external execution，因此取消仍可先成为 terminal fact；EXECUTING、UNKNOWN 与 CONFLICT 的外部 outcome 尚未安全结算，取消会被拒绝。

记下 `runId`，通过 `inspect` 读取 `state.approvalBinding.bindingHash`，再原样提交：

```bash
node dist/src/cli.js inspect --runtime-home .runtime --run-id <run-id> --json

node dist/src/cli.js approve-plan \
  --runtime-home .runtime \
  --run-id <run-id> \
  --binding-hash <state.approvalBinding.bindingHash> \
  --json

node dist/src/cli.js trace --runtime-home .runtime --run-id <run-id> --json

node dist/src/cli.js operation --runtime-home .runtime --run-id <run-id> --json
```

计划审批是跨进程可恢复且幂等的。其 binding 覆盖 question、不可变 plan artifact、完整 Source Scope、Run Budget，以及显式启用时的 Retry Policy；模型输出、Research Tool 参数、环境变量或调用方自造 Receipt 都不能替代用户命令。Retry Policy 会改变自动执行外部调用的上限，因此它是 durable Run fact，而不是重启进程可以偷偷替换的本地选项。

`operation` 是 control-plane 的只读视图：active lease 暴露 operation/owner identity、kind、heartbeat 与 expiry；最近 cancellation request 暴露 request identity 与是否已消费。它与 `inspect` / `trace` 一样不会取得 lease。lease 与 request 都不进入 Run Journal 或 Run Projection，不能被用来推断研究结果。

## 暂停、恢复、取消与扩展预算

`pause` 只把可继续工作状态包装为 `user_paused`，并在 `suspendedState` 中保留精确 continuation。`resume` 只接受该状态；它先恢复 Journal 中已有的 pending Model Turn/tool fact，不重新采样已经完成的工作。`cancel` 先独立持久化 cancellation request；active owner 在 heartbeat/poll safe-point 把它传播到 provider `AbortSignal`，再把 request consumption 与 terminal `run_cancelled` 原子提交。请求方或 owner 崩溃时，下一 mutation 会先消费 pending request。外层 `cancelled` 永远不可恢复。

```bash
node dist/src/cli.js pause --runtime-home .runtime --run-id <run-id> --json
node dist/src/cli.js resume --runtime-home .runtime --run-id <run-id> --json
node dist/src/cli.js cancel --runtime-home .runtime --run-id <run-id> --json
```

`budget_exhausted` 保留 `incomplete` 或 `research_complete` provenance。用户必须提交一个不同版本、逐维不缩减且至少提高一个限制的新预算；Runtime 创建绑定前后预算 canonical hashes 的 `RunBudgetApprovalReceipt`，然后恢复耗尽前的精确状态。

```bash
node dist/src/cli.js extend-budget \
  --runtime-home .runtime \
  --run-id <run-id> \
  --version budget-v2 \
  --max-model-turns 16 \
  --max-tool-calls 60 \
  --max-distinct-sources 24 \
  --max-source-bytes 5000000 \
  --max-wall-time-ms 420000 \
  --json
```

计划和 publication approval waits 本身也是 Suspended Run：对应 approval 命令会从 durable waiting state 继续。`completed`、`cancelled` 与 `failed` 没有合法 resume 或新工作转换。

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

## 配置 safe read sibling 并发

`safeReadConcurrency` 是 Harness 局部执行上限，默认 4、合法范围 1–32。Runtime 会先按模型原始 tool-call order 完成参数 schema、Source Root/Source Scope 与 source-byte、distinct-source 预算预留，再启动批准的 search/read。Journal 的 completion events 按 Artifact/Snapshot 已形成的真实完成先后提交；Projection 和下一轮 Model View 则按原始 intent order 重建，所以交换物理完成顺序不会改变模型输入。并发 Retry Attempts 会在 terminal transition 前全部闭合；若结算前崩溃，重启会先恢复未闭合 attempts，再结算已经 durable 的 terminal sibling，不会先 retry 或重跑 intent。retry backoff 返回后也会重新检查 cancellation，已取消 Run 不会启动下一次 Search。

```ts
const runtime = ResearchAgentRuntime.open({
  runtimeHome: ".runtime",
  model,
  safeReadConcurrency: 4,
});
```

一个 sibling 的普通失败只消费自己的 intent，其他已批准成功 observation 仍会提交。取消会阻止 worker 启动尚在队列中的调用；已经完整形成的结果仍可进入 cancelled snapshot 供审计，但不会触发后续 `record_evidence`、`propose_claim`、`complete_research`、Gate 或 publication。启用 Retry Policy 时，每个 sibling search 在外部 I/O 前分别提交 durable attempt，transient failure 只重试自己的 Retry Sequence，并继续复用同一个逻辑 `toolCallId`。

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

每个外部调用前先追加 `retry_attempt_started`；失败后追加带 duration、规范 failure、实际 retry delay 的 `retry_attempt_failed`。成功 Model Turn 或 Search observation 与成功 attempt 在同一 SQLite transaction 提交。attempt 上限耗尽进入 suspended `retry_exhausted`；Model contract、未知永久错误或可持久化 invariant violation 进入 terminal `failed`。Search 普通执行失败则形成 `tool_execution` observation，保留给下一轮模型，不会不加区分地终止整个 Run。

## 从来源到 Learning Artifact 的显式 TypeScript API

Issue #5 的显式命令仍从 TypeScript public seam 暴露，方便独立学习每一个边界。Research Loop 内部复用同一 source/evidence/claim 领域规则，并不会绕过 reducer、SQLite 或 Evidence Gate。

```ts
import { resolve } from "node:path";
import { ResearchAgentRuntime, ScriptedEvaluator } from "./src/index.js";
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
  evaluator: new ScriptedEvaluator(),
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

  await runtime.recordClaim({
    runId: afterRead.runId,
    kind: "inference",
    text: "Projection 因此可以作为可替换的派生视图。",
    evidenceIds: [evidence.evidenceId],
  });

  await runtime.recordClaim({
    runId: afterRead.runId,
    kind: "design_recommendation",
    text: "建议只通过 Journal 事实恢复 Projection。",
    evidenceIds: [],
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

- `advanceResearch` 每次都从 Run Journal、Projection 与批准 plan artifact 重建 Model View；Model View 不是 Journal，也不是完整 `messages[]`。完整 Model Turn 先 durable append；开头连续的 replay-safe search/read 经过模型顺序 preflight 后可并发，其余 pending intents 顺序消费，重启后不会要求模型猜测未决动作。
- Model/search 外部 I/O 前必须先 durable 提交 `in_progress` attempt。重启看到未完成 attempt 时，会先持久化 `model_turn_interrupted` 或 `search_interrupted`，然后只在冻结 policy 允许时重试；已原子提交的成功 attempt/Model Turn/observation 不重新执行。Search 的多个物理 attempts 共享一个 `toolCallId`，因此 retry 不伪造成额外逻辑 Tool Call。
- provider retry hint 是最短等待，不会被 Harness backoff cap 截短；等待和 attempt 都消耗 Research Loop wall time。等待若已经耗尽已批准 wall-time，Runtime 会在下一次外部 I/O 前进入 `budget_exhausted`。
- Run Trace 对 Model contract、Model permanent、permission denial、stale state、ordinary tool execution、infrastructure transient 与 invariant violation 使用稳定、无秘密的 failure category/code；attempt 还暴露 Retry Sequence kind/identity、序号、结果、duration、policy version 和 retry delay。
- 五个模型可见工具之外的 approval、budget change、publication、shell 与任意写入都不进入 `ResearchToolIntent` 联合。参数 schema 错误、Source Scope denial、stale observation 和普通工具失败都会形成安全 observation，进入下一轮视图。
- Run Budget 由 Harness 与 reducer 共用一个 domain calculator 从 canonical facts 计算：计划 generation、Research Loop turns、Research Tool calls、不同 Source Snapshot、完整 source bytes 与 Research Loop wall time 分别记账。完成工具会在自己的 durable `completedAt` 再检查 Model Turn/wall time，并把该时间冻结为 Research Loop 计费终点；之后的用户空闲或重复 inspect/advance 不会追溯耗尽预算。任何硬维度耗尽都会 durable 进入带 `incomplete` 或 `research_complete` provenance 的 `budget_exhausted`，该状态不能生成 draft 或伪装为可发布完成。
- user pause 与 budget exhaustion 的等待时间累计进 `suspendedDurationMs`，不消耗 Research Loop wall time；预算扩展不会清零已有 usage，也不能改变 plan、Source Scope 或 approval authority。
- cancellation 先成为 terminal Journal fact 时，已经完整返回的 Model Turn、Search/read、Evidence、Claim、completion 或 aborted Retry Attempt 仍可追加到 `cancelledState` 供审计；外层保持 `cancelled`，所以这些 late results 不会触发 queued tool、Gate 或 publication。
- 每个既有 Run 最多有一个未到期 mutating Run Operation lease；竞争命令在任何模型、工具、文件或 Journal 副作用前得到 `RunBusyError` / CLI `RUN_BUSY`。不同 Runs 可并行，`inspect`、`trace` 与 `operation` 始终只读。
- heartbeat 与 expiry 使用独立 control-plane clock，不消耗 Research Loop wall time。owner 崩溃后 lease 只证明 ownership 已过期；接管者必须从 Run Journal 恢复 pending attempt/tool/cancellation，不能根据 lease 猜业务结果。
- `search_sources` 通过可注入 `SourceSearchPort` 使用默认固定参数 `rg` adapter；它在启动搜索前复核批准 root identity，并把 extensions、exclusions、共享 secret discovery globs 与 file-size bound 下推到 discovery，每个返回命中还会再走共享 realpath preflight。完整命中列表进入私有 JSON Artifact，Journal/Trace 只保留引用和数量，下一轮 Model View 再按需校验展开；搜索不会创建 Source Snapshot。
- `readSource` 仍只接受 `{ rootIndex, relativePath, startLine, endLine }`，且只允许 `researching` Run；显式完成后会在文件/CAS I/O 前拒绝新读取。成功读取才会保存完整原始 UTF-8 字节到私有 `source-sha256:<hash>` Snapshot；`denied`/`failed` 只写安全 observation，不创建 Snapshot。
- 一个 Evidence Record 只能逐字段绑定一个现有成功 observation 的 `observationId`、`toolCallId`、Snapshot identity、规范范围和 excerpt hash。Claim 必须显式分类：`source_fact` 与 `inference` 至少引用一个既有 Evidence；`design_recommendation` 可无 Evidence，提供时也必须有效。
- Evidence Gate 不信任 live source 或仅自洽的 Journal 字段：它从私有 CAS 按 content identity 读取完整 immutable Snapshot bytes，重新验证 Source Scope、completed tool-call lineage、1-based range、logical lines、excerpt 和 hash。live 文件后续变化不会追溯破坏既有 Evidence，Snapshot 损坏或范围/摘录不匹配则 fail closed。
- Gate 失败会追加 typed `evidence_gate_repair_requested` 并从 `research_complete` 回到 `researching`。下一 Model View 固定显示 stable code、summary 与 recommended action；已完成但 schema-invalid 的 Artifact proposal generation 也以 `proposal_invalid` repair 计入 Run Budget，repair 不伪装成 Research Tool call，也不进入 terminal `failed`。若批准的 Source Root path/device/inode 已失效，则在调用 draft 模型前记录 `approval_invalid`，并要求创建和批准新的 Research Run/Source Scope。
- `ModelPort.proposeLearningArtifact` 只能返回标题、恰好一句话的摘要和**既有** Claim IDs 的展示顺序。Markdown renderer 是唯一生成 `【Evidence: <id>】` citation 的地方；Claim 行显示 ID/分类，Evidence Index 对共享 Evidence 去重并同时显示 Snapshot/range/tool-call identity。tool usage summary 从 durable observations 逐类计算 `search_sources`、`read_source`、`record_evidence`、`propose_claim` 与 `complete_research` 调用次数，不从 selected Evidence 反推。Trace 的 Claim event 暴露 kind 与 Evidence IDs，任一 artifact Claim 都能沿结构化 identity 追到 source read。title、summary 或 Claim 中夹带的预渲染 `【Evidence:` token 会被拒绝。
- Evaluator Port 只接收用户问题、最终展示顺序的 Claims 与各自 cited Evidence；每个 Claim 必须恰好得到一个同序封闭 verdict。失败后的 retry 保持 exact input/proposal/target，显式 skip 只记录用户 identity，不生成 review 或 verdict。publication approval projection 同时公开 hard Gate pass 摘要和由 review/skip 派生的 advisory warnings。
- `outputRoot` 是 Runtime 打开时显式配置、且与 private Runtime Home 不重叠的 canonical 目录。private Markdown draft 的 hash、Output Root identity、canonical target path 和目标父目录 `device`/`inode` 共同构成 publication binding。任何 binding、root 或 parent identity 变化都会使旧 approval 失效。
- normal publish 不覆盖不同既有内容：publisher 使用同目录 `0600` temporary file、fsync 和 atomic hard-link no-clobber publication。真正写出前会再次从私有 CAS 验证 approved draft 的完整 Snapshot lineage 与 reviewed JSON Artifact；draft/approval 后任一私有 bytes 缺失或篡改会保持 `ready_to_publish` 并 fail closed。已有文件若字节完全一致则幂等成功；final symlink、非文件、不同字节或父目录替换同样会被拒绝。
- Publication Effect 以 Run Journal facts 表达 PENDING、EXECUTING、UNKNOWN、CONFLICT 与 SUCCEEDED；Run Operation lease 只表达 command ownership，不能代替外部 effect outcome。prepare、PENDING retry 与 reconcile 每次都重验 exact approval action。matching target 不重写，missing target 保留 effect identity，different target 永不覆盖，inconclusive inspection 持久保留 UNKNOWN。
- 一旦 effect 进入 EXECUTING，取消请求会被拒绝，直到显式 reconcile 把 outcome 结算为 SUCCEEDED、PENDING 或仍需用户处理的状态；这防止 terminal `cancelled` 永久掩盖可能已发生的外部写入。

## Journal、Trace 与恢复边界

Run Journal 是 canonical history；Projection cache、Model View 和 Trace 都可丢弃并重建。Trace 按顺序保留 Retry Attempts、completed Model Turns、轻量工具 observations、来源读取的 observation/tool call/Snapshot、Evidence、Claim kind/Evidence IDs、Evidence Gate repair code、research completion/budget/retry suspension、terminal failure、draft、publication receipt 与最终 Markdown SHA-256；search 行正文只存在于被引用的私有 Artifact，并只在最近 Model View 窗口按需展开。`ResearchLoopLifecycleHooks` 在 attempt started、Model Turn 以及五个 Research Tool 的命名 durable seam 注入中断：attempt started 后的中断证明未完成 I/O 可以跨重启分类并按 policy 恢复；search/read 还覆盖 CAS Artifact/Snapshot 写入后与 Journal 事务提交后；Evidence/Claim/completion 覆盖 Journal commit 前后。成功事实若 SQLite commit 失败，命令只返回稳定错误，Journal 中仍只有 `in_progress` attempt；它不会声称 Model Turn 已持久化。`complete_research` 若在同一时刻暴露预算耗尽，会把 `research_completed` 与 `run_budget_exhausted` 放进一个 SQLite event batch，崩溃无法留下 exhausted 但可发布的单独 `research_complete`。Trace 不包含绝对来源路径、私有 Runtime Home、search 行正文、provider payload 或 OS 错误。

`publication_approved` 只表示用户授权了精确 draft/target，状态为 `ready_to_publish`。重启不会自动写文件；显式 publish 依次进入 PENDING 和 EXECUTING，只有 direct settlement 或显式 reconcile 的 matching settlement 才追加 `learning_artifact_published` 并进入 `completed`。命名 fault points 覆盖 prepare、temporary write、atomic publication、success settlement 与 reconciliation 的前后边界。

Node.js 24 没有可移植的 `openat`/`openat2` 与 `renameat2(RENAME_NOREPLACE)`。来源读取和 target publication 都使用 symlink 拒绝、`O_NOFOLLOW`、file-handle/parent identity 复核，对稳定可观测变化 fail closed；它们不承诺隔离 hostile same-user concurrent rename。

## 学习入口

- `src/application/research-agent-runtime.ts`：public command seam、两层 user approval、Evidence Gate 之前的模型边界与外部 publication 调用点。
- `src/infrastructure/private-source-search.ts`：固定参数 `rg`、root identity 复核、discovery 过滤与逐命中 realpath preflight。
- `src/domain/reducer.ts`：追加 Journal 如何确定性派生 Evidence/Claim/draft/approval/completed 状态，并重新验证所有关联。
- `src/domain/evidence-gate.ts`、`src/domain/evaluator-review.ts` 与 `src/domain/learning-artifact.ts`：结构化引文授权、隔离 review identity 和 deterministic report renderer。
- `src/infrastructure/private-source-access.ts`：canonical Source Scope、handle 读取与 Snapshot 前的 policy boundary。
- `src/infrastructure/sqlite-run-store.ts`：Journal、Projection cache、Source Snapshot registry 与通用 artifact registry 的事务对应关系。
- `src/infrastructure/learning-artifact-publisher.ts`：target identity、same-directory no-clobber atomic publication 与不同内容拒绝。
- `tests/runtime/learning-artifact-publication.test.ts`：独立 ScriptedModel/ScriptedEvaluator happy path、Evaluator retry/skip、CAS tamper、Publication Effect fault matrix、matching/missing/conflict/UNKNOWN reconcile 与 Trace lineage。
- `tests/runtime/research-loop.test.ts`：五工具多轮 happy path、重启后 pending intent 恢复、search port/artifact 边界、replay 防篡改、错误 observation、五维预算暂停、steering/pinned Model View 与确定性裁剪。
- `tests/runtime/retry-policy.test.ts`：Model/Search transient retry、provider hint、attempt lineage、policy approval/restart、崩溃恢复、普通失败、schema/permanent/invariant failure、wall-time 与 SQLite commit failure。
- `tests/runtime/run-control.test.ts`：pause/resume、预算版本扩展、terminal cancellation、stream/pending tool/completed result race 与 Suspended Run 取消矩阵。
- `tests/runtime/run-operation.test.ts`：run_busy、read-only access、跨 Run 并行、heartbeat、expiry、stale owner takeover 与 durable cancellation request。
- `tests/cli/cli.test.ts`：process-like CLI graduation、独立 control commands、publish 与真实 crash fixture 后的 reconcile。
- `tests/evals/live-plan-eval.test.ts`：版本化 fixture、重复 trial、identity/cost/latency/verdict 记录与 deterministic judge 分离。
- `docs/graduation-matrix.md`：Issue #15 每条 acceptance criterion 与 fault boundary 的实现/测试映射。
- `docs/architecture.md`：组件图、状态机、publication effect 的明确恢复边界。

## 当前运行边界与限制

- 这是单机、单用户、local-text MVP；不是多租户服务，也没有远程 source connector、浏览器、shell 或任意写工具。
- CLI 的 `advance`、`propose-artifact` 与 `retry-evaluator` 每次都会从环境创建 live adapter，并要求 Experiment Identity 与已批准 Run 精确一致；CLI 尚不提供 Scripted fixture 文件格式作为生产运行模式。
- Runtime Home 与 Output Root 必须由调用者妥善保护。Journal/CAS 提供一致性与恢复语义，不提供静态加密、OS 级访问控制或恶意同用户进程隔离。
- provider 侧日志、传输策略与数据保留不受本项目控制；source 摘录会进入已配置的模型 provider。不要把未获授权的私密来源纳入 Source Scope。
- Node.js 24 缺少可移植 `openat2` 与 `renameat2(RENAME_NOREPLACE)`；实现能拒绝 symlink、复核 handle/parent identity 并对稳定可观测替换 fail closed，但不能原子隔离 hostile same-user concurrent rename。
- SQLite/CAS 不包含跨机器 replication、backup protocol 或灾难恢复；Publication Effect reconcile 只对单一已批准 target 的可观测状态分类。
- live plan eval 当前没有 token usage 与本地能耗计量，只验证计划结构和 forbidden terms；它不衡量答案质量，也不替代 deterministic Evidence Gate。
- Evaluator Review 是 advisory model evidence。即使 verdict 全部 supported，publication 仍依赖 deterministic Gate 与 exact user approval；显式 skip 会在 report/Trace 中保留 warning。
