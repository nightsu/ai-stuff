# Evidence Research Agent

这是一个以学习 Agent 工程为目的的本地 TypeScript 项目。当前完成到 Issue #5：一条已经 durable Plan Approval 的 Run 可以显式读取批准范围内的来源、冻结完整 private Source Snapshot、登记 `source_fact` Evidence Record 和 Claim、通过最小 Evidence Gate 生成 Markdown draft，再由用户精确批准 draft、Output Root 与 target，最后发布一份可读的 Learning Artifact。

它不是自动研究流程。当前没有 `search_sources`、多轮 Research Loop、自动工具调度、retry、live model、`read-source` CLI 或 publication CLI。

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

计划审批是跨进程可恢复且幂等的。其 binding 覆盖 question、不可变 plan artifact、完整 Source Scope 与 Run Budget；模型输出、Research Tool 参数、环境变量或调用方自造 Receipt 都不能替代用户命令。

## 从来源到 Learning Artifact 的 TypeScript API

Issue #5 的命令只从 TypeScript public seam 暴露。下面的顺序刻意显式：调用方先读取来源，再选择哪个成功 observation 成为 Evidence，再写 Claim；模型只在最后选择已有 Claim 的展示顺序，并不能创造 citation identity。

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

- `readSource` 仍只接受 `{ rootIndex, relativePath, startLine, endLine }`。成功读取才会保存完整原始 UTF-8 字节到私有 `source-sha256:<hash>` Snapshot；`denied`/`failed` 只写安全 observation，不创建 Snapshot。
- 一个 Evidence Record 只能逐字段绑定一个现有成功 observation 的 `observationId`、`toolCallId`、Snapshot identity、规范范围和 excerpt hash。一个 Claim 显式标为 `source_fact`，且只能引用当前 Run 已登记的 Evidence IDs。
- Evidence Gate 会拒绝空、未知或重复的 Claim/Evidence 关系，并从 Journal 重算已批准 Run Budget 的 model turns、tool calls、按 Source Snapshot identity 去重的 distinct sources、source bytes 与 wall time。它不通过时不创建 draft artifact、更不会触碰用户 target。
- `ModelPort.proposeLearningArtifact` 只能返回标题、摘要和**既有** Claim IDs 的展示顺序。Markdown renderer 是唯一生成 `【Evidence: <id>】` citation 的地方，并固定输出 `Claims`、`Evidence Index` 与紧凑 `Tool usage`；title、summary 或 Claim 中夹带的预渲染 `【Evidence:` token 会被拒绝，因此模型不能伪造可见引文。
- `outputRoot` 是 Runtime 打开时显式配置、且与 private Runtime Home 不重叠的 canonical 目录。private Markdown draft 的 hash、Output Root identity、canonical target path 和目标父目录 `device`/`inode` 共同构成 publication binding。任何 binding、root 或 parent identity 变化都会使旧 approval 失效。
- normal publish 不覆盖不同既有内容：publisher 使用同目录 `0600` temporary file、fsync 和 atomic hard-link no-clobber publication。已有文件若字节完全一致则幂等成功；final symlink、非文件、不同字节或父目录替换都会 fail closed。

## Journal、Trace 与恢复边界

Run Journal 是 canonical history；Projection cache 和 Trace 都可丢弃并从 Journal 重建。Trace 按顺序保留安全 lineage：来源读取的 observation/tool call/Snapshot，每个 Evidence 的相同 observation/tool call/Snapshot，再到 Claim ID、draft artifact ID、publication receipt ID 与最终 Markdown SHA-256；它不包含源正文、绝对来源路径、私有 Runtime Home 或 OS 错误。

`publication_approved` 只表示用户授权了精确 draft/target，状态为 `ready_to_publish`。重启不会自动写文件；只有显式 `publishLearningArtifact` 成功返回后才追加 `learning_artifact_published` 并进入 `completed`。如果进程在外部写入尝试和该 Journal 事件之间崩溃，当前实现不会把“文件可能存在”猜成完成；完整 effect crash reconciliation 留给 Issue #14。

Node.js 24 没有可移植的 `openat`/`openat2` 与 `renameat2(RENAME_NOREPLACE)`。来源读取和 target publication 都使用 symlink 拒绝、`O_NOFOLLOW`、file-handle/parent identity 复核，对稳定可观测变化 fail closed；它们不承诺隔离 hostile same-user concurrent rename。

## 学习入口

- `src/application/research-agent-runtime.ts`：public command seam、两层 user approval、Evidence Gate 之前的模型边界与外部 publication 调用点。
- `src/domain/reducer.ts`：追加 Journal 如何确定性派生 Evidence/Claim/draft/approval/completed 状态，并重新验证所有关联。
- `src/domain/evidence-gate.ts` 与 `src/domain/learning-artifact.ts`：结构化引文授权和 deterministic Markdown renderer。
- `src/infrastructure/private-source-access.ts`：canonical Source Scope、handle 读取与 Snapshot 前的 policy boundary。
- `src/infrastructure/sqlite-run-store.ts`：Journal、Projection cache、Source Snapshot registry 与通用 artifact registry 的事务对应关系。
- `src/infrastructure/learning-artifact-publisher.ts`：target identity、same-directory no-clobber atomic publication 与不同内容拒绝。
- `tests/runtime/learning-artifact-publication.test.ts`：ScriptedModel happy path、Gate、target identity、direct replay tamper 与 Trace lineage。
- `docs/architecture.md`：组件图、状态机、publication effect 的明确恢复边界。

## 尚未实现

- Issue #6：真正的 `search_sources`、模型可见 Research Tools 与有界多轮 Research Loop。
- Issue #7：明确错误分类、retry policy、attempt 记录和恢复状态。
- Issue #8：Vercel AI SDK `streamText` 驱动的 OpenAI-compatible live Model Port；SDK 类型仍必须隔离在 `ModelPort` 后。
- Issue #14：publication 外部 effect 的 durable operation、crash reconciliation 与精确恢复协议。
