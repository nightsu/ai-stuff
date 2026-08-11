# 第 3 章 streaming-markdown：跨 chunk 状态机与 append-oriented DOM

> 仓库：[`thetarnav/streaming-markdown`](https://github.com/thetarnav/streaming-markdown)  
> 固定 commit：[`6beb92d991ed5a16f62cdfefac739b6eee45555f`](https://github.com/thetarnav/streaming-markdown/commit/6beb92d991ed5a16f62cdfefac739b6eee45555f)  
> 本轮版本：`0.2.15`  
## 本章要解决的问题

如果调用方只传新增字符，parser 就不能依赖下一次重新读取完整 source。本章研究开放 token、父节点栈和待定属性怎样跨 chunk 存活。

## 本章目标

| 项目 | 内容 |
|---|---|
| 前置知识 | 第 1 章；有限状态机和 DOM 基础 |
| 本章重点 | `parser_write`、跨 chunk state、renderer callbacks、optimistic parsing |
| 第一遍重点 | parser state、token stack、`add_text/set_attr/end_token` |
| 完成后应能回答 | 为什么 append-oriented 不等于绝不修改旧 DOM？如何验证任意 chunk 切分都正确？ |

## 核心心智模型

streaming-markdown 是本组最纯粹的增量实现：调用方只传新增 chunk，parser 跨 chunk 保存状态和 token 栈，renderer 以追加节点/文本为主。它不依赖 React reconcile，也不重新解析累计全文；但链接或图片闭合时会给已经创建的元素后设属性，所以严格说是 append-oriented，而不是完全不修改既有 DOM。代价是语法覆盖、组件生态、安全默认值和高亮能力都更窄。

```mermaid
flowchart LR
  CHUNK["新增 chunk"] --> WRITE["parser_write"]
  WRITE --> FSM["跨 chunk 字符状态机"]
  FSM --> EVENT["add_token / add_text / set_attr / end_token"]
  EVENT --> STACK["renderer 开放节点栈"]
  STACK --> DOM["createElement / createTextNode / appendChild"]
  DOM --> OLD["既有 DOM 不重建"]
```

## 核心源码原文：跨 chunk 状态与 append DOM

真正增量入口的关键语句原样摘录如下；仅省略中间的换行/缩进控制流和注释：[源码 L468-L499](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L468-L499)。

```js
export function parser_write(p, chunk) {
    for (const char of chunk) {
        if (p.token === NEWLINE) {
            switch (char) {
            case ' ':
                p.indent_len += 1
                continue
            case '\t':
                p.indent_len += 4
                continue
            }
        }
        const pending_with_char = p.pending + char
```

- `parser_write(p, chunk)`：API 接受新增 chunk，并继续使用同一个 parser `p`。
- `for (const char of chunk)`：只遍历本次新增字符，不重新传入累计全文。
- `p.token`、`p.indent_len`、`p.pending`：状态保存在 parser 对象中并跨调用延续。
- `pending_with_char`：语法判定建立在旧 pending 与当前字符上；这是真正的跨边界状态机，而不是示意性的 `advanceStateMachine` 调用。

默认 renderer 的 append 行为也可直接从原文确认：[源码 L1607-L1622](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1607-L1622)。

```js
data.nodes[++data.index] = parent.appendChild(slot)

export function default_add_text(data, text) {
    data.nodes[data.index].appendChild(document.createTextNode(text))
}

export function default_set_attr(data, type, value) {
    data.nodes[data.index].setAttribute(attr_to_html_attr(type), value)
}
```

- `appendChild(slot)`：新 token 直接追加到当前父节点，同时推进开放节点索引。
- `createTextNode(text)`：正文不通过 `innerHTML`。
- `setAttribute(...)`：URL 等属性也直接写入，因此必须额外建立协议 allowlist。
- 这里没有 React tree，也没有重新构造旧 DOM subtree。

## 1. Parser 保存哪些跨 chunk 状态

源码锚点：[`smd.js L179-L224`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L179-L224)

```js
// 学习版等价伪代码
const parser = {
  pending: '',       // 尚不足以判定语法的字符
  text: '',          // 等待 flush 的普通文本
  token: rootToken,  // 当前开放 token
  tokenStack: [],    // 嵌套 emphasis/list/link/code 等
  indent: 0,
  fence: null,
  blockquote: 0,
  table: null,
}
```

这里保存的是 parser 语义状态，而不只是“已经处理到哪个字符”。因此 chunk 可以在 delimiter、UTF-8 解码后的任意字符或 token 中间断开。

## 2. `parser_write` 只消费新增字符

源码锚点：[`smd.js L468-L515`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L468-L515)

```js
// 学习版等价伪代码
function parser_write(parser, chunk) {
  // 注意：chunk 是新增内容，不是累计全文。
  for (const char of chunk) {
    parser.pending += char

    // 根据当前状态和 pending 判断：
    // - 继续等待更多字符；
    // - flush 普通文本；
    // - 开始/结束 token；
    // - 设置 URL、语言等属性。
    advanceStateMachine(parser)
  }
}
```

如果总输出长度为 N，每个字符在正常情况下只进入状态机一次；这与每次把长度 1、2、3…N 的累计字符串重新 parse 有本质区别。

## 3. Renderer interface 如何解耦 parser 与 DOM

源码锚点：[`renderer interface L1480-L1512`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1480-L1512)

```js
// 学习版等价伪代码
const renderer = {
  add_token(type) {}, // 开始一个结构节点
  end_token() {},     // 关闭当前节点
  add_text(text) {},  // 追加文本
  set_attr(name, value) {},
}
```

这不是 React 的 tag→component map，而是 token event protocol。可以实现 DOM renderer，也可以实现日志、AST-like tree 或其它平台 renderer。

## 4. 默认 DOM renderer 为什么是 append-oriented

源码锚点：[`DOM renderer L1527-L1623`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1527-L1623)

```js
// 学习版等价伪代码
function add_token(type) {
  const element = document.createElement(tagFor(type))
  currentParent.appendChild(element)
  openNodes.push(element)
}

function add_text(text) {
  openNodes.at(-1).appendChild(document.createTextNode(text))
}

function end_token() {
  openNodes.pop()
}

function set_attr(type, value) {
  // 链接/图片闭合时，给已存在元素补 href/src 等属性。
  openNodes.at(-1).setAttribute(attrFor(type), value)
}
```

旧 subtree 不会被替换，节点与文本主要通过 `appendChild` 增长，因此用户文本选区通常更稳定，也没有 React reconciliation。但它并非绝对“旧 DOM 不回写”：链接/图片在闭合时通过 [`set_attr`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1149-L1154) 为已创建元素设置 URL，再由默认 renderer 直接 [`setAttribute`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1620-L1623)。另一方面，长会话 DOM 会持续增长；库本身没有 React 式组件生命周期或通用虚拟化层。

## 5. Optimistic parsing 如何显示未闭语法

当解析器看到 inline code、fence、emphasis 等起点时，会尽早打开对应 token/DOM element，而不是等待结束 delimiter 才显示。这样流式文字立即获得样式；如果模型最终没有闭合，当前开放结构仍代表“到目前为止最合理的解释”。[官方行为说明](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/readme.md#L45-L68)

与其它包对照：

- Streamdown：临时补 delimiter 或移除不安全尾部。
- XMarkdown：隐藏 pending 或显示 loading component。
- streaming-markdown：直接打开 token，并跨 chunk 保持开放状态。

## 6. 代码高亮与组件扩展

源码锚点：[`language attribute L672-L684`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L672-L684)

代码 fence 能把语言写入 class/attribute，但库本身不包含 Shiki/Prism。若希望在 code 仍增长时高亮，需要自行决定：

- 每个 chunk 重新高亮当前 code；
- fence 完成后一次高亮；
- 使用能增量更新 token 的专用高亮器。

扩展通常通过自定义 renderer callbacks 完成，而不是把任意 HTML tag 映射为 React component。

## 7. 安全模型的优势与缺口

优势：

- 正文通过 `createTextNode` 添加，不使用 `innerHTML`。
- 一般 raw HTML 不解析，缩小了 HTML 注入表面。

缺口：

- link/image URL 会被捕获后直接 `setAttribute`，默认源码没有完整协议 allowlist。[URL capture](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1126-L1157) [setAttribute](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1615-L1623)
- 没有默认的外链确认、图片代理或 CSP 集成。

用于不可信 LLM/用户内容时，应在自定义 `set_attr` 中实施 URL scheme allowlist，并区分 link、image、data URI 策略。

## 8. Chunk-invariance 测试为什么重要

源码锚点：[`test helper L312-L339`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd_test_setup.js#L312-L339)

测试 helper 对同一 case 执行两种输入：

```js
// 整串一次写入
parser_write(parserA, markdown)

// 最极端边界：逐字符写入
for (const char of markdown) parser_write(parserB, char)

// 真实 helper 建立两个独立测试：两种输入方式分别与同一个 fixture 比较。
assert.deepEqual(treeA, expectedChildren)
assert.deepEqual(treeB, expectedChildren)
```

两条断言通过共同 fixture 间接保证整串与逐字符结果一致，并验证跨 chunk state 是否正确；源码不是直接执行 `treeA === treeB`。本轮还实际复跑了整个 test suite，结果见下一节。

## 9. SSR、测试与 benchmark 证据边界

### SSR / 运行时

Parser 只依赖 renderer callback，因此理论上可以在服务端配合自定义 renderer 使用；但默认 `default_renderer(root)` 明确要求 `HTMLElement`，并调用 `document.createElement`、`createTextNode` 与 `appendChild`。[默认 renderer L1527-L1623](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1527-L1623) 因此默认实现是浏览器 DOM renderer，不是开箱即用的 SSR HTML renderer。

### 测试证据

测试 helper 会把同一 fixture 分别以整串和逐字符方式输入，并各自与共同 `expected_children` 比较。[helper L312-L339](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd_test_setup.js#L312-L339) 这比只测试一个固定 chunk 大小更能暴露跨边界状态问题。本轮在固定 commit 本地执行 `node --test --test-reporter=tap`：870 tests、870 pass、0 fail；这是功能回归证据，不是性能结果。

完成阶段也与有 `static/final` 全量重解析的 React 方案不同：[`parser_end`](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L226-L234) 只在仍有 `pending` 时额外写入一个换行以触发 flush；它不会 reset parser，也不显式关闭全部开放 token，更不会用完整 Markdown 重建最终语义树。

### Benchmark 证据

固定 commit 没有提供可与 React 渲染器公平比较的端到端 benchmark 结果。逐字符状态机避免累计全文重 parse 是源码事实，但 DOM 数量、重组件、高亮与长会话内存仍需产品侧测量。

## 10. 低版本浏览器与 iOS

streaming-markdown 的默认行为最直接：bundle 和 DOM renderer 能执行时，每次 `parser_write(chunk)` 都立即追加文本或节点；第一次 write 之前根节点为空。`parser_end()` 只是触发 pending flush，不会切换到一次完整静态 parse，所以它不会在旧浏览器上自动变成“等 final”。

固定源码按原生 ESM/现代 JavaScript 发布，build 没有 legacy target；默认 renderer 还依赖 `document`、`HTMLElement` 和 DOM 操作。缺少语法、DOM 或 renderer callback 时错误直接向上传播，更可能进入 ErrorBoundary/空白，而不是等待完成。[构建配置](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/build.js#L12-L37) [默认 DOM renderer](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/smd.js#L1527-L1623)

如果必须支持老设备，应由应用提供转译后的 bundle，并准备完全独立的静态 renderer：不能真实读取响应流时，先拿完整文本，再交给 Marked/react-markdown 等 final-only 路径。这个库适合自主管理 renderer 的团队，不适合期待组件自动完成兼容降级的产品。

## 11. 语法覆盖与工程代价

官方 feature matrix 明确列出 reference links、复杂 table、一般 HTML 等缺口。[feature matrix](https://github.com/thetarnav/streaming-markdown/blob/6beb92d991ed5a16f62cdfefac739b6eee45555f/readme.md#L84-L149)

适合：

- 需要真正新增 chunk API 和 append-oriented DOM。
- 希望学习跨 chunk parser state 的最小实现。
- 能接受较窄语法，并愿意自建 URL 安全、高亮和组件层。

不适合：希望直接得到完整 React AI Markdown 产品体验、remark/rehype 生态或复杂 HTML/数学/图表支持。

## 本章练习

使用一个提供 `TEXT / EMPHASIS / CODE` 状态与 TODO 转换的最小 FSM 骨架，补完强调和 inline code；让同一文本分别整段、逐字符和随机 chunk 输入，并记录开放 token 栈。link 与属性后设作为进阶扩展，不要求第一次学习从零实现完整 parser。

### 练习验收

- 不同 chunk 切分得到等价 final DOM；
- 必做：强调和 inline code 在不同 chunk 切分下等价；
- 进阶：link 未闭合前不会写入危险 href，闭合后可以后设安全属性；
- `reset` 后旧 token stack 不再影响新文档。

## 检查理解

1. parser 必须跨 chunk 保存哪些事实？
2. optimistic parsing 带来了什么 UX 收益和最终语义风险？
3. `parser_end` flush 与完整静态重解析有什么区别？

## 本章小结

真正增量的核心是保存语法状态，而不是让 UI 更频繁地更新。后续三章将用它作为参照，分析 React 产品为何常选择不同折中。

---

[上一章：react-markdown](02-react-markdown.md) · [课程目录](00-learning-guide.md) · [下一章：Ant Design X Markdown](04-ant-design-x-markdown.md)
