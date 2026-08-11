# Mission: 流式 Markdown Renderer 源码学习

## Why

把不同渲染器的源码整理成一条可以逐步掌握的工程路径，最终能够独立设计、实现和验证流式 Markdown renderer，而不是只会根据库名做选型。

## Success looks like

- 能准确指出增量发生在网络、parser、token、AST、React 还是 DOM；
- 能设计 streaming/final/reset 三种生命周期；
- 能用 chunk-invariance、final equivalence 和 stable identity 验证实现；
- 能处理未闭语法、重组件、安全与旧浏览器降级。

## Constraints

- 中文教材式表达，先建立基线再进入优化；
- 源码结论固定到 commit；
- benchmark、社区快照和审阅过程放在证据附录；
- 补充内容优先使用 trace、反例和测试，不机械增加篇幅。

## Out of scope

- 完整复述每个库的 API；
- 在没有统一负载时给出跨库性能排名；
- 把传输流、打字动画和增量 parser 混为一谈。
