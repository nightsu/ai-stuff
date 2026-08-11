# Bubble List 自动滚动：答案要点与状态 Trace

课程规范术语统一为 `FOLLOWING / USER_SCROLLING / DETACHED`，并使用独立 `PENDING_BOTTOM`。上游项目自己的 escaped/sticky 等名称只在源码解释中出现。

## 第 1 章 Ant Design X

- `atBottom` 是几何事实，following 是未来承诺；`autoScroll=true` 只是配置，不代表始终 following。
- 用户离底后图片晚加载不能夺回阅读位置；显式回底命令是例外。
- 常见错误：把 10px/50ms 当通用常量；每次 items 变化强制滚底。

## 第 2 章 use-stick-to-bottom

- wheel up 或稳定的向上 scroll：`FOLLOWING → USER_SCROLLING → DETACHED`。
- content resize 不应触发 detach；进入 near-bottom 或显式请求才能恢复 `FOLLOWING`。
- 常见错误：选区存在就立即 detach；把 spring 只当视觉效果而不记录程序意图。

## 第 3 章 assistant-ui

- 未完成布局时 `PENDING_BOTTOM` 可以跨 resize 保留；pointerdown/用户向上输入可以取消它。
- 只有 `scrollHeight` 稳定时，向上移动才足以作为用户接管证据。
- 常见错误：把 pending intent 编码进 `atBottom`；top anchor 与 bottom follow 同时执行。

## 第 4 章 两轴控制器

- 正确状态组合示例：`DETACHED + atBottom=false + PENDING_BOTTOM` 可以暂时同时存在，直到命令完成或被用户取消。
- DOM 几何只由 adapter 读写；状态机接收事件并产生命令，不直接读取浏览器。
- 常见错误：把 `PENDING_BOTTOM` 设为第四个互斥 followMode；把 near-bottom 设为长期状态。

## 第 5 章 竞态实验

- 必测不变量：用户输入优先、内容 resize 不伪造用户意图、pending 完成后才稳定 following、cleanup 后无命令。
- 合格失败报告必须包含 geometry、event source、state、pending intent 和 scroll command 时间线。
- 常见错误：只断言最终 `scrollTop`；只在 JSDOM 中证明浏览器输入行为。

## 进阶 A synthetic scroll

- `sticky=true` 时可以暂时 `atEnd=false`，例如程序动画尚未完成。
- 尺寸快照只能增加证据，不能完全证明事件来源；时间窗口必须用竞态实验验证。

## 进阶 B 虚拟测量

- 数据追加、最后一项渲染和真实高度测量是三个时刻；follow 必须等待 virtualizer 的稳定信号。
- prepend 后保持阅读 anchor；外层 `scrollTop=scrollHeight` 会绕过测量系统并破坏锚点。
