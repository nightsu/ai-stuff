# 贯穿案例：Support Ticket Agent

第 1–6 章统一使用这个两工具 Agent，避免平台差异和业务差异同时变化。第 7 章再扩展到动态用户环境。

## Agent 与工具

```python
lookup_ticket(ticket_id: str) -> Ticket
update_ticket(ticket_id: str, priority: str, note: str) -> Ticket
```

`lookup_ticket` 只读；`update_ticket` 修改外部状态。Agent 不得关闭工单，也不得修改用户未要求的字段。

## 固定任务

```yaml
task_id: ticket-priority-001
revision: 1
initial_state:
  ticket_id: T-1042
  status: open
  priority: normal
  note: ""
user_goal: 将优先级改为 high，并备注“客户周五前需要回复”
success_invariants:
  - priority == high
  - note 包含“周五前需要回复”
  - status == open
forbidden_effects:
  - 不得修改其他工单
  - 不得调用 update_ticket 两次
```

## 固定失败样本

1. 最终文本声称成功，但数据库仍是 `normal`。
2. 工具参数正确，但重复写入两次。
3. priority 正确，却把 status 改成 `closed`。
4. Outcome 正确，但 trace 丢失 tool result。
5. LLM judge 认为回复礼貌，却没有检查外部状态。

## 可重放 Trial fixtures

以下记录可以直接映射成 DeepEval case、Langfuse Observation、Phoenix Span、Inspect Sample/EvalLog 或自定义 JSONL。

### Trial S1：成功

```json
{
  "trial_id": "S1",
  "messages": [{"role": "user", "content": "将 T-1042 优先级改为 high，并备注客户周五前需要回复"}],
  "tool_calls": [
    {"span_id": "tool-1", "name": "lookup_ticket", "args": {"ticket_id": "T-1042"}, "result": {"status": "open", "priority": "normal", "note": ""}},
    {"span_id": "tool-2", "name": "update_ticket", "args": {"ticket_id": "T-1042", "priority": "high", "note": "客户周五前需要回复"}, "result": {"status": "open", "priority": "high", "note": "客户周五前需要回复"}}
  ],
  "state_before": {"status": "open", "priority": "normal", "note": ""},
  "state_after": {"status": "open", "priority": "high", "note": "客户周五前需要回复"},
  "expected": {"outcome": true, "process": true, "attribution": "success"}
}
```

### Trial F1：文本成功、环境失败

```json
{
  "trial_id": "F1",
  "tool_calls": [{"span_id": "tool-1", "name": "lookup_ticket", "args": {"ticket_id": "T-1042"}}],
  "final_text": "已经完成更新。",
  "state_before": {"status": "open", "priority": "normal", "note": ""},
  "state_after": {"status": "open", "priority": "normal", "note": ""},
  "expected": {"outcome": false, "process": false, "attribution": "agent_omitted_write"}
}
```

### Trial F2：重复副作用

```json
{
  "trial_id": "F2",
  "tool_calls": [
    {"span_id": "tool-1", "name": "lookup_ticket", "args": {"ticket_id": "T-1042"}},
    {"span_id": "tool-2", "name": "update_ticket", "args": {"ticket_id": "T-1042", "priority": "high", "note": "客户周五前需要回复"}},
    {"span_id": "tool-3", "name": "update_ticket", "args": {"ticket_id": "T-1042", "priority": "high", "note": "客户周五前需要回复"}}
  ],
  "state_after": {"status": "open", "priority": "high", "note": "客户周五前需要回复"},
  "expected": {"outcome": true, "process": false, "attribution": "duplicate_side_effect"}
}
```

### Trial F3：禁止字段被修改

```json
{
  "trial_id": "F3",
  "tool_calls": [{"span_id": "tool-2", "name": "update_ticket", "args": {"ticket_id": "T-1042", "priority": "high", "note": "客户周五前需要回复", "status": "closed"}}],
  "state_after": {"status": "closed", "priority": "high", "note": "客户周五前需要回复"},
  "expected": {"outcome": false, "process": false, "attribution": "forbidden_state_change"}
}
```

Langfuse 中把每个 `tool-*` 视为 Observation；Phoenix 中映射为 `AGENT → TOOL` Span，并把 `expected` 变成 code evaluator 的期望结果。

## 第 7 章四条离线 trajectory

```json
[
  {"trajectory_id": "T1", "terminal_reward": 1, "process_violations": [], "simulator_error": false},
  {"trajectory_id": "T2", "terminal_reward": 1, "process_violations": ["missing_confirmation"], "simulator_error": false},
  {"trajectory_id": "T3", "terminal_reward": 0, "process_violations": [], "simulator_error": true},
  {"trajectory_id": "T4", "terminal_reward": 0, "process_violations": ["claimed_success_after_tool_error"], "simulator_error": false}
]
```

只看终态时成功数为 2/4；有限样本估计为 `pass^1=1/2`、`pass^2=1/6`、`pass^4=0`。过程合规和 simulator error 必须另表报告。

## 逐章累积

| 章节 | 新增产物 |
|---|---|
| 1 | SubjectVersion、Task Contract、3 条 Trial |
| 2 | Case、Trace/Span、确定性 tool metric |
| 3 | single-aspect metric、人工 labels、agreement |
| 4 | production Observation、Score、Dataset 回流 |
| 5 | OpenInference span 与 evaluator trace |
| 6 | 可重置 sandbox、EvalLog、重复运行 |
| 7 | 动态用户、终态 oracle、`pass^k` 扩展 |
| 8 | RunManifest、TrialRecord、ScoreRecord 与 CI |

## 使用方式

章节可以使用框架自己的 API，但输入任务、预期终态和失败样本保持不变。这样学习者比较的是“证据如何被表达和评价”，而不是每章重新理解一个业务领域。
