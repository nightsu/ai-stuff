# 课程实验协议

这份协议让十章练习使用同一套安全、可重复、可比较的产物格式。它不是完整自动验收 harness，但在编写代码前先固定 fixture、故障点和期望 trace，避免练习退化成一次不可复现的演示。

## 每次练习的最小产物

```text
exercise-name/
  README.md              # 目标、固定版本、运行命令
  fixtures/              # 本地、可重置、无真实凭证的数据
  trace-normal.jsonl     # 一条正常路径
  trace-failure.jsonl    # 一条故障/恢复路径
  assertions.md          # 预期事件、状态和不变量
  notes.md               # 实际结果、偏差和未解决问题
```

`assertions.md` 至少回答：

- 最终状态是什么？
- 模型调用、工具调用和审批各发生几次？
- 哪个 identity 关联 intent、prompt、effect 与 result？
- 故障后哪些代码重跑，哪些副作用没有重跑？
- 哪条不变量由哪一条 trace 证明？

## 安全规则

- secret 练习只使用临时目录中的随机 canary；禁止读取真实 `.env`、SSH key、云凭证和系统钥匙串。
- 消息、邮件、支付、发布和部署使用 stub connector 或本地 fake server；禁止把故障注入指向生产目标。
- 浏览器练习使用可重置的 localhost fixture，不依赖会漂移的第三方网页。
- sandbox 练习只挂载专用临时目录，不使用整个用户目录作为 writable root。
- 每次练习结束后检查 trace，确认合成 secret 和无关本地路径没有进入模型输入。

## 固定故障注入点

优先从下列边界选择至少一个：

1. model output 尚未持久化；
2. tool intent 已持久化、approval item 尚未建立；
3. approval 已解决、执行尚未开始；
4. 外部副作用成功、result 尚未持久化；
5. 并行分支产生 pending write、superstep 尚未提交；
6. observation 产生后、action 执行前环境版本改变；
7. checkpoint 成功、最新外部状态尚未对账。

故障注入必须使用进程退出、明确异常或 fixture 状态切换，不能只在文档中假设“这里失败”。

## 章节 Fixture 建议

| 章节 | 确定性 fixture | 最低验收信号 |
|---|---|---|
| smolagents | 两步本地数据转换 + canary 文件 | error observation 进入下一轮；真实凭证未读取 |
| Agents SDK | triage + stub refund tool | RunState 恢复后不重新采样 pending action |
| LangGraph | 两个固定 evidence 分支 | 调换完成顺序不改变 reducer 结果 |
| browser-use | localhost 动态表单 | stale action 被拒绝并重新观察 |
| Codex | 临时目录 shell stub | forbidden/rejected/sandbox denial/command failure 可区分 |
| OpenHands | JSONL event log + 虚拟 workspace | unmatched action 恢复；读写资源锁顺序正确 |
| OpenWorker | SQLite Inbox + stub message target | prompt 补建、first-responder-wins、effect 对账 |
| CrewAI | 固定三阶段任务 | 两个故障点的重放范围和状态 owner 可比较 |
| MAF | 两 executor + approval middleware | middleware 顺序改变可由事件次数证明 |
| AutoGen | 内存 topic runtime + 可丢弃 queue | state 恢复后明确报告在途消息边界 |

## 反馈闭环

完成练习后，不先重读章节，直接回答本章“检查理解”。再对照 `assertions.md` 和 trace 修正答案。至少隔一天重新解释一次失败路径；若无法从记忆指出 state owner、重放范围和副作用身份，练习尚未形成长期掌握。

