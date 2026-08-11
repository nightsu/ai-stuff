# 流式 Markdown 练习 Fixture 与最小骨架

## 固定 corpus

````md
普通段落与 **强调**、`inline code`。

```ts
const answer = 42;
```

[安全链接](https://example.com) 与 ![图片](https://example.com/a.png)
````

另准备三个失败输入：未闭 code fence、未闭 link、`javascript:` URL。

## Chunk 策略

同一 corpus 至少使用：

1. 整段输入；
2. 逐字符输入；
3. delimiter 前后切分；
4. 固定 seed 的随机 chunk；
5. 中间改写后发送 `replace/reset`。

## 第 3 章最小 FSM 骨架

```ts
type Mode = "TEXT" | "EMPHASIS" | "CODE";

type ParserState = {
  mode: Mode;
  pendingDelimiter: string;
  output: Token[];
};

function write(state: ParserState, chunk: string): ParserState {
  for (const char of chunk) {
    // TODO 1: 根据 mode 与 char 转换状态
    // TODO 2: delimiter 跨 chunk 时保留 pendingDelimiter
    // TODO 3: 只追加新 token，不重建稳定前缀
  }
  return state;
}

function reset(): ParserState {
  return { mode: "TEXT", pendingDelimiter: "", output: [] };
}
```

必做只覆盖 emphasis 与 inline code；link 属性后设是进阶。

## 第 6 章 instrumentation 骨架

下面的 renderer 已提供三层处理入口；练习只补计数与失效原因，不要求实现缓存算法。

```ts
type Counters = {
  tokenPrefixHits: number;
  tokenRebuilds: number;
  nodeIdentityHits: number;
  nodeRebuilds: number;
  reactMemoHits: number;
  reactRenders: number;
  resetReasons: string[];
};

type Snapshot = {
  source: string;
  optionsHash: string;
  tokens: Token[];
  nodes: RenderNode[];
};

function instrumentedRender(
  previous: Snapshot | null,
  source: string,
  optionsHash: string,
  counters: Counters,
): Snapshot {
  const appendOnly = previous && source.startsWith(previous.source);
  const sameOptions = previous?.optionsHash === optionsHash;

  if (!appendOnly) counters.resetReasons.push("NON_PREFIX_REWRITE");
  if (!sameOptions) counters.resetReasons.push("OUTPUT_OPTIONS_CHANGED");

  const tokens = lex(source);
  // TODO 1: 比较稳定 token prefix，更新 tokenPrefixHits/tokenRebuilds。
  const nodes = toRenderNodes(tokens, optionsHash);
  // TODO 2: 比较 node identity，更新 nodeIdentityHits/nodeRebuilds。
  // TODO 3: 在 React wrapper 中更新 reactMemoHits/reactRenders。

  return { source, optionsHash, tokens, nodes };
}
```

测试顺序：尾部追加 → final → 非前缀改写 → 修改组件映射/optionsHash。每步分别记录三层 hit/miss，不能合并成单一 cache rate。

## 第 7 章测量表

```text
source length:
chunk count:
parse invocations:
characters scanned:
transformed blocks:
stable blocks reused:
React commits:
heavy-component executions:
p50 / p95:
```

同一轮比较不得改变 corpus、插件、chunk seed、设备或构建模式。
