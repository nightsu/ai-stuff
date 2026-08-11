# 流式 Markdown 课程：答案要点与常见错误

本文件提供判分点，不替代亲自画 trace 和运行测试。先完成练习，再对照答案。

## 第 1 章 Marked

- 答案要点：`preprocess → lexer → token walk → parser → postprocess` 都在一次完整编译内；sanitize、stream 生命周期和 React/DOM 不属于 Marked。
- 可观察产物：同一 source 更新 10 次时，记录 lexer/parser 调用次数和扫描字符总量。
- 常见错误：把 tokenizer/renderer 实例复用写成 AST 增量复用。

## 第 2 章 react-markdown

- 答案要点：processor 配置可以复用，但 `children` 变化仍重新执行 parse/run；React reconciliation 只发生在 Markdown 管线之后。
- 可观察产物：插件执行计数、mdast/hast 节点数、React commit 次数分开记录。
- 常见错误：只看到 DOM 节点没替换，就断言 Markdown 没有重解析。

## 第 3 章 streaming-markdown

- 答案要点：chunk 之间至少保存当前 token、父节点栈、delimiter/属性状态；`final/reset` 必须显式结束或清空这些状态。
- 预期 trace：整段、逐字符、随机 chunk 的 final DOM 等价；`reset` 后首个 token 不继承旧 emphasis/code 状态。
- 常见错误：在 link 未闭合时提前写 `href`；把完整静态重解析当作 `parser_end`。

## 第 4 章 Ant Design X Markdown

- 答案要点：suffix recognizer 可以增量扫描新增字符，但可见 output 变化后仍走完整 Marked、sanitize 和 HTML→React。
- 预期失效：非前缀改写必须 reset；未传 streaming 标记时不能声称测到 suffix cache。
- 常见错误：把“尾部稳定”与“全文编译成本下降”混为一谈。

## 第 5 章 Streamdown

- 答案要点：默认 streaming 下先全文修复并全文 lex；稳定 block 主要跳过后续 unified transform 和 React render。
- 预期 trace：尾部增长时 parse/lex 计数仍增加，完成 block 的 transform/render 计数保持稳定。
- 常见错误：把 processor/highlighter 实例缓存计入 block 输出缓存。

## 第 6 章 markstream-react

- 答案要点：token prefix、structured node、React node 是三层不同 identity；schema/options 改变可以逐层关闭快速路径。
- 预期产物：三层分别记录 hit/miss/rebuild reason，而不是只报告一个 cache hit rate。
- 常见错误：JSON 内容相同就假定 React object identity 稳定；把 virtualization 当作 parser 优化。

## 第 7 章 架构比较

- 答案要点：使用 worksheet 比较 scanned characters、transformed blocks、React commits 和重组件执行次数；调度优先级不等于工作量减少。
- 合格结论：必须写出目标负载、设备和一个会让当前选择失效的变化。
- 常见错误：引用不同 corpus 或不同插件条件下的单次排名。

## 第 8 章 兼容与降级

- 答案要点：bundle、transport、renderer、heavy component 和 hydration 是不同失败层；final-only 只解决 transport/streaming 能力不足。
- MVP 预期：禁用任一增强能力后仍显示正文、状态和安全处理；不能持续空白。
- 常见错误：认为 Fetch polyfill 一定保留 streaming；降级路径绕过 sanitize。

## 第 9 章 综合实践

- MVP 必须通过：chunk invariance、final equivalence、reset、安全 URL/HTML policy。
- 正确性扩展：稳定 block 不重复执行重插件，固定 corpus 覆盖未闭 fence/link。
- 常见错误：只测最终 HTML，不记录 parser/block/plugin/React 的工作量与 identity。
