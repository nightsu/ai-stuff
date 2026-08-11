# 第 6 章 markstream-react：parser、结构节点与 React 三层复用

> 仓库：[`Simon-He95/markstream-vue`](https://github.com/Simon-He95/markstream-vue)  
> 固定 commit：[`ec0f30735e1aefa6dd74d517732166e12eefa13a`](https://github.com/Simon-He95/markstream-vue/commit/ec0f30735e1aefa6dd74d517732166e12eefa13a)  
> 本轮版本：`markstream-react 0.0.56-beta.1`、`stream-markdown-parser 1.1.9`  
## 本章要解决的问题

当长文已经同时遇到 parser、结构转换和 React 提交瓶颈，只做 block memo 可能不够。本章研究三层复用怎样协作，以及快速路径为什么必须有严格前提。

## 本章目标

| 项目 | 内容 |
|---|---|
| 前置知识 | 第 1–5 章 |
| 本章重点 | token prefix、structured node reuse、object identity、batch 与 virtualization |
| 第一遍重点 | stream parse gate、stable group、render context 与 viewport scheduling |
| 完成后应能回答 | 三层 cache 分别依赖什么 identity？哪些扩展会让系统回退完整路径？ |

## 核心心智模型

markstream-react 是本组 React 方案中复用层次最深的：底层 stream parser 尝试复用 token 前缀，结构转换层复用稳定顶层 nodes，React 层再稳定对象引用、逐节点 memo、分批渲染和虚拟化。代价是 beta API、更大的实现面，以及自定义扩展可能主动关闭快速路径。

```mermaid
flowchart LR
  SRC["累计 source + final"] --> SP["md.stream.parse"]
  SP --> TOK["复用稳定 token 前缀"]
  TOK --> GROUP["验证顶层 group 边界"]
  GROUP --> NODE["复用前缀 structured nodes，只处理 tail"]
  NODE --> ID["稳定 node object identity"]
  ID --> MEMO["NodeSlotContent React.memo"]
  MEMO --> BATCH["批量渲染 / 视口延迟"]
  BATCH --> VIRT["长文虚拟化"]
```

## 核心源码原文：stream 门控与稳定前缀复用

Parser 是否进入真正 stream 分支，由以下未经改写的条件决定：[源码 L628-L637](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/src/parser/index.ts#L628-L637)。

```ts
const streamParse = options.streamParse ?? 'auto'
return internalOptions.__disableStreamParse !== true
  && (md as unknown as Record<string, unknown>).__markstreamHasCustomParserExtensions !== true
  && (streamParse === true || (streamParse === 'auto' && options.final !== true))
  && stream?.enabled === true
  && typeof stream.parse === 'function'
```

- `streamParse ?? 'auto'`：默认值不是布尔值，而是三态控制。
- 自定义 parser extension 会关闭 fast path，避免复用未知语义。
- `streamParse === true`：显式 true 不受 `final` 限制。
- `auto && final !== true`：只有默认 auto 会在 final 切回完整解析。
- 底层 stream 插件还必须实际启用并提供 `parse`。

顶层 node 复用的完整 guard 与成功分支如下：[源码 L397-L420](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/src/parser/index.ts#L397-L420)。

```ts
if (previous
  && stableGroupCount > 0
  && previous.requireClosingStrong === options.requireClosingStrong
  && source.startsWith(previous.source)
  && groupStarts.length >= stableGroupCount
  && (mode === 'append' || mode === 'tail')
  && hasStableStructuredStreamGroupBoundaries(previous, tokens, groupStarts, stableGroupCount)
) {
  const tailStart = groupStarts[stableGroupCount] ?? tokens.length
  const tailNodes = processTokensWithTiming(tokens.slice(tailStart), options, timing)
  const expectedTailNodes = groupStarts.length - stableGroupCount

  if (tailNodes.length === expectedTailNodes) {
    const result = previous.nodes.slice(0, stableGroupCount).concat(tailNodes)
    addTiming(timing, 'processTokensReusedTopLevelNodes', stableGroupCount)
    updateStructuredStreamCache(md, source, tokens, groups, result, options)
    return result
  }
}
```

- `previous`：必须已经存在可复用缓存。
- `stableGroupCount > 0` 与 `requireClosingStrong`：必须真的存在稳定前缀，且影响强调闭合语义的选项未变化。
- `source.startsWith(previous.source)`：只接受尾部追加，回写会退出快速路径。
- `groupStarts.length >= stableGroupCount`：新 token 分组不能短于准备复用的旧前缀。
- `append/tail`：底层 parser 必须确认本次没有退化成 sync/reset。
- `hasStable...Boundaries`：不仅比较文本，还验证 token group 边界身份。
- `tokens.slice(tailStart)`：只把第一个不稳定 group 之后的 tokens 转成 nodes。
- `tailNodes.length === expectedTailNodes`：尾部节点数量也必须符合分组预期，否则不命中快速路径。
- `previous.nodes.slice(...).concat(...)`：全部 guard 通过后，稳定前缀才直接沿用旧结构节点。

React 层还会恢复稳定 node 的对象 identity：[源码 L107-L126](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/src/components/NodeRenderer.tsx#L107-L126)。

```ts
if (prev && isNodeStable(prev, newNodes[i])) {
  result[i] = prev
} else {
  result[i] = newNodes[i]
  identical = false
}
```

这段是逐节点 `React.memo` 能命中的前提：结构相同就恢复旧引用，而不是只依赖 parser 恰好返回同一个对象。

## 1. Parser 为什么默认进入 stream mode

源码锚点：[`factory.ts L181-L232`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/src/factory.ts#L181-L232)

```ts
// 学习版等价伪代码
function factory(options = {}) {
  const streamEnabled = options.markdownItOptions?.stream ?? true

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    experimental: { stream: streamEnabled },
  })

  // 未自定义 validateLink 时，安装默认危险 URL 检查。
  if (!options.validateLink) md.set({ validateLink: safeUrlValidator })

  // 再安装数学、容器、流式缩进/list/table/HTML 等修复规则。
  return applyStreamingFixes(md)
}
```

与 Streamdown 在 parser 外做 `remend + lex` 不同，这里使用带 stream 能力的 MarkdownIt 实例作为基础。

## 2. 什么情况下使用或放弃 stream parse

源码锚点：[`shouldUseTopLevelStreamParse L628-L650`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/src/parser/index.ts#L628-L650)、[`parseTopLevelTokens L1631-L1672`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/src/parser/index.ts#L1631-L1672)

```ts
// 学习版等价伪代码
function shouldUseStream(md, options) {
  const requested = options.streamParse ?? 'auto'

  return !options.__disableStreamParse
    && !md.__markstreamHasCustomParserExtensions
    // 显式 true 即使 final 也可继续 stream parse；默认 auto 才在 final 关闭。
    && (requested === true || (requested === 'auto' && options.final !== true))
    && md.stream?.enabled
    && typeof md.stream.parse === 'function'
}

function parseTopLevelTokens(md, source, options) {
  if (!shouldUseStream(md, options)) {
    return md.parse(source)              // 正确性优先：回退完整同步 parse
  }

  const tokens = md.stream.parse(source) // 内部识别 append/tail/reset

  // 特定数学边界或重复 token 风险出现时，再 reset 并回退同步路径。
  if (needsSafetyFallback(tokens, source)) {
    md.stream.reset()
    return md.parse(source)
  }

  return tokens
}
```

`streamParse='auto'` 时，`final=true` 会回到完整 parse 并清理 stream cache，保证最终语义不长期依赖容错状态；如果调用方显式指定 `streamParse:true`，即使 final 也允许继续使用 `stream.parse`。因此“final 必然全量解析”不是无条件事实。

## 3. 顶层 structured nodes 如何复用

源码锚点：[`reuse eligibility L309-L317`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/src/parser/index.ts#L309-L317)、[`process with reuse L376-L423`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/src/parser/index.ts#L376-L423)

```ts
// 学习版等价伪代码
function canReuseNodes(options) {
  return options.__reuseStableTopLevelNodes
    && !options.final
    && !options.preTransformTokens
    && !options.postTransformTokens
    && !options.postTransformNodes
    && !options.customHtmlTags?.length
    && !options.includeSourceMap
}

function processWithReuse(source, tokens, previous) {
  const groups = findReusableTopLevelGroups(tokens)

  const safe = source.startsWith(previous.source)
    && ['append', 'tail'].includes(parserMode)
    && groupBoundariesStillUseSameTokenObjects(groups, previous)

  if (!safe) return processAll(tokens)

  // 已稳定前缀直接复用旧 nodes，只转换本次 tail tokens。
  const tailNodes = processTokens(tokens.slice(firstUnstableGroup))
  return previous.nodes.slice(0, stableGroupCount).concat(tailNodes)
}
```

这是比 Streamdown block memo 更靠前的一层优化：不仅跳过 React render，还跳过稳定前缀的 token→structured node 转换。

关闭条件同样重要。自定义 transforms、source map、自定义 HTML tag 会改变结构输出，源码选择禁用复用而不是冒险返回陈旧节点。

## 4. React 节点 identity 如何保持稳定

源码锚点：[`stabilizeParsedNodes L71-L127`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/src/components/NodeRenderer.tsx#L71-L127)、[`NodeSlotContent L145-L173`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/src/components/NodeRenderer.tsx#L145-L173)

```tsx
// 学习版等价伪代码
function stabilizeParsedNodes(nextNodes, previousNodes) {
  return nextNodes.map((next, index) => {
    const prev = previousNodes[index]

    // raw 相同还不够；loading/autoClosed/sourceMap/diff 也会影响视觉输出。
    return prev && isStructurallyStable(prev, next)
      ? prev   // 复用旧对象引用
      : next
  })
}

const NodeSlotContent = React.memo(
  ({ node, renderCtx }) => renderNode(node, renderCtx),
  (prev, next) => prev.node === next.node && prev.renderCtx === next.renderCtx
)
```

parser 可能仍返回新的 node 对象，`stabilizeParsedNodes` 会在视觉相关字段相同时恢复旧 identity，从而让 `React.memo` 真正命中。

## 5. 为什么 `renderCtx` 也要稳定

源码锚点：[`render context L1299-L1369`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/src/components/NodeRenderer.tsx#L1299-L1369)

```tsx
const renderCtx = useMemo(() => ({
  components,
  htmlPolicy,
  themes,
  events,
  // 其它真正影响节点输出的配置
}), [stableConfigurationDependencies])

// 高频 stream 状态通过可变 ref 更新，避免让 renderCtx 每个字符换 identity。
renderCtx.streamRenderVersion = streamVersionRef.current
renderCtx.textStreamState = textStateRef.current
```

如果只稳定 node，却每次创建新的 context，逐节点 memo 仍会全部失效。这是实现 React 层复用时很容易漏掉的细节。

## 6. 批量渲染与虚拟化默认值

源码锚点：[`NodeRenderer defaults L28-L54`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/src/components/NodeRenderer.tsx#L28-L54)

```ts
const defaults = {
  batchRendering: true,
  initialRenderBatchSize: 40, // 首屏先给足内容
  renderBatchSize: 80,        // 后续分批增加
  renderBatchBudgetMs: 6,     // 单批主动控制主线程预算
  deferNodesUntilVisible: true,
  maxLiveNodes: 320,          // 超过后启用虚拟化窗口
  liveNodeBuffer: 60,
}
```

这解决的是“已经有很多结构节点，如何不一次挂载全部 DOM”，与 parser 增量是另一层问题。

## 7. Smooth streaming 的职责

源码锚点：[`smooth-stream-controller L35-L86`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-core/src/smooth-stream-controller.ts#L35-L86)

```ts
const pacingDefaults = {
  minCharsPerSecond: 40,
  maxCharsPerSecond: 1000,
  targetLatencyMs: 900,
  catchUpLatencyMs: 350,
  maxCommitFps: 30,
  maxCharsPerCommit: 80,
}
```

controller 按 grapheme 而不是 UTF-16 code unit 切分，控制可见文本追赶 source 的速度。它优化视觉节奏和 React commit 频率；真正的 parser/node 复用来自前述独立模块。

## 8. 安全与扩展边界

- factory 默认安装危险链接检查。
- React renderer 提供 `htmlPolicy` 等策略；安全 HTML、自定义 HTML 与 trusted HTML 应分开审查。
- 自定义 parser/node transforms 可能关闭复用快速路径。
- Mermaid、D2、Monaco、Shiki 等可选能力增大 bundle、异步状态与安全表面。

因此不能只比较“是否支持功能”，还要比较实际启用配置下的依赖图、SSR 行为、CSP 和长会话内存。

## 9. SSR、测试与 benchmark 证据边界

### SSR / 运行时

`markstream-react` 明确发布独立 [`./server` export](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/package.json#L59-L66)，其 [`server.ts`](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/src/server.ts#L1-L68) 转出 server-renderer 版本的 NodeRenderer 与节点组件。客户端/Next 入口、虚拟化、tooltip、worker、Mermaid/D2/Monaco 等仍有浏览器能力；SSR 集成应使用对应 export，而不是假设默认入口的所有交互组件都能在服务端执行。

### 测试证据

- Parser tests 覆盖 stream parser integration、ordered-list jitter、streaming math/fence、table loading midstate 等回归。[stream parser integration](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markdown-parser/test/stream-parser-integration.test.ts#L1-L40)
- 这些测试支持“仓库关注流式边界”的判断，但本文没有执行完整 pnpm workspace 测试，不能声称本 checkout 全部通过。
- Node identity、batch、virtualization 的真实收益仍需要 React Profiler、滚动行为和内存测试；仅看 parser tests 不足以证明端到端性能。

### Benchmark 证据

根 workspace 提供 `benchmark:streaming-split`、`benchmark:heavy-restore`、`benchmark:real-corpus` 与 release-gate benchmark 脚本。[scripts](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/package.json#L117-L135) 本文没有运行并固化这些结果，因此只把它们视作 benchmark 基础设施，不声称 markstream-react 已在同一环境胜过其它候选。

## 10. 低版本浏览器与 iOS

markstream-react 不会自动改为“等 final”，但它对可选调度能力的功能级降级相对完整：缺少 `IntersectionObserver` 时可把节点视为可见，[源码](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/src/context/viewportPriority.tsx#L172-L203)；`requestAnimationFrame`、idle callback、`queueMicrotask` 也有 timer、立即执行或 Promise fallback。结果通常是减少延迟渲染/平滑效果，而不是内容永久空白。

这不等于无限向下兼容。React 要求 ≥18，发布构建目标是 [ES2019](https://github.com/Simon-He95/markstream-vue/blob/ec0f30735e1aefa6dd74d517732166e12eefa13a/packages/markstream-react/vite.config.ts#L57-L66)；Worker、AbortController、ResizeObserver、Mermaid、Monaco 等重能力仍应逐项检测。核心可执行时它继续流式，只是调度可能退化；核心 bundle/React 不兼容时仍可能报错。

推荐把旧设备策略分层：保留核心 Markdown，关闭 Mermaid/Monaco/动画/虚拟化；代码块回退 `<pre><code>`；Fetch Streaming 不可用时缓存全文并以 `final: true` 提交。这样可以牺牲增强体验而保住正文。

## 11. 成熟度与选型建议

优势：

- parser/token、structured node、React node 三层复用。
- 面向长文的 batch、viewport defer 和 virtualization。
- streaming/final 生命周期明确，失败时有同步回退。

代价：

- React 包仍为 beta。
- 状态组合和可选组件显著多于 Streamdown/XMarkdown。
- 快速路径有明确前提；复杂自定义能力可能让性能退回全量处理。

适合：超长 AI 输出、大量顶层节点、已确认 parser/React 都是瓶颈的产品。普通聊天消息应先用真实负载证明这些复杂性确实必要。

## 本章练习

对给定的长文 renderer 增加 instrumentation，而不是从零实现三层缓存：分别统计 token prefix、structured block 与 React node 的命中/重建次数；再启用一个会改变 node schema 的自定义扩展，观察快速路径如何失效。virtualization 作为进阶观察项。

### 练习验收

- 三层命中率和失效原因可以分别记录；
- final、非前缀改写和扩展配置变化会走正确 reset 路径；
- 进阶：virtualized/offscreen 节点不会破坏最终内容顺序与 identity。

## 检查理解

1. token prefix 相同为什么仍可能无法复用 structured node？
2. React object identity 与相同 JSON 内容有什么差别？
3. batch、defer、virtualization 分别减少 CPU、提交频率还是可见节点数？

## 本章小结

markstream-react 展示了最深的 React 复用路径，也带来最多状态与失效条件。下一章把六个项目压缩成可比较的架构模型。

---

[上一章：Streamdown](05-streamdown.md) · [课程目录](00-learning-guide.md) · [下一章：架构比较](07-comparison.md)
