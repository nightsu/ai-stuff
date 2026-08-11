# Mission: AI Agent 设计与源码

## Why

把分散的 Agent 框架与产品源码整理成一套可以反复学习、推演和复刻的中文教材，最终能够独立设计可靠的 Agent runtime，而不是只会调用某个框架 API。

## Success looks like

- 能从陌生 Agent 仓库中快速定位主循环、状态事实源、授权点和恢复入口；
- 能实现一个具备 typed tools、持久状态、审批、隔离和失败恢复的最小 Agent；
- 能根据任务类型选择 loop、workflow、event、browser 或 multi-agent 架构；
- 能明确说明哪些副作用仍需要幂等键、事务或额外安全边界。

## Constraints

- 中文教材式表达，循序渐进；
- 优先使用固定提交源码和一方资料；
- 章节服务于学习，不保留对话过程、审计过程或无关排行榜；
- 控制篇幅，以理解、推演和练习效率为准。

## Out of scope

- 为每个框架编写完整 API 手册；
- 复述 README 功能清单和 provider 配置；
- 用 stars 或单一 benchmark 选“最佳 Agent”；
- 在没有实测时比较任务成功率和性能。

