# Mission: Bubble List 自动滚动源码学习

## Why

把聊天自动滚动从零散 effect 和浏览器启发式整理成可理解、可实现、可验证的状态机课程，最终能在普通列表和虚拟列表中保护用户阅读位置。

## Success looks like

- 能分离 atBottom、following 和 pending intent；
- 能解释用户、内容、程序与浏览器事件的仲裁；
- 能处理 streaming resize、selection、软键盘和 prepend；
- 能用真实浏览器竞态测试验证实现。

## Constraints

- 源码固定到 commit；
- 核心主线先完成普通列表，legacy heuristics 与虚拟测量作为进阶支线；
- 时间窗口必须标为启发式；
- 补充内容以状态转换和测试效率为准。

## Out of scope

- 给出适用于所有浏览器的固定毫秒常量；
- 只凭 JSDOM 宣称滚动行为可靠；
- 把消息规模简化为统一虚拟化阈值。
