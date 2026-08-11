# AI Agent Evaluation：答案要点与判分点

默认答案基于[Support Ticket Agent](CASE-STUDY.md)。先完成练习，再用这些判分点校准。

## 第 1 章 评价共同语言

- 正确 Outcome：`priority=high`、note 命中目标、`status=open`；Agent 的完成声明不能替代状态检查。
- 三条 Trial 至少包含成功、错误终态、禁止副作用之一。
- 常见错误：SubjectVersion 只写模型名；Task 没有 revision 或已知可通过解。

## 第 2 章 DeepEval

- trace-level metric 判断整项任务，`update_ticket` span metric 判断工具参数，数据库 oracle 判断外部状态。
- 错误参数应定位到具体 span；环境未更新不能被礼貌回复抵消。
- 常见错误：把所有 metric 挂在 trace；让 LLM judge 判断确定性数据库事实。

## 第 3 章 Ragas

- single-aspect metric 只判断回复是否准确说明已完成的字段变更，不同时判断文风、工具效率和安全。
- 8 条 labels 要报告 agreement 和主要分歧；30+ labels 是生产扩展。
- 常见错误：reference-free 被理解为无需人工校准；只保存 score 不保存 reason/trace。

## 第 4 章 Langfuse

- 失败 Score 应绑定 `update_ticket` Observation，并保留 source trace、task revision、去敏记录和 Dataset item。
- 候选版本 Experiment 必须能重现原失败，而不是只把日志复制进 Dataset。
- 常见错误：只给整条 Trace 一个总分；把线上随机日志直接当 benchmark。

## 第 5 章 Phoenix

- AGENT→LLM→TOOL 父子关系正确；Invocation 与 Response Handling 分开评价。
- evaluator trace 要能追到输入映射、grader version、输出、错误和 evidence reference。
- 常见错误：annotation 绑定错 span；把 Phoenix OSS 与外部在线调度能力混为一体。

## 第 6 章 Inspect AI

- 每个 sample 前环境重置；scorer 同时检查目标字段、禁止状态变化和重复写入。
- EvalLog 至少能还原 messages、tools、state diff、score、error、task/subject/environment revision。
- 常见错误：只检查最终文本；多 epoch 共用被前一 Trial 修改的环境。

## 第 7 章 τ-bench / τ³-bench

- 终态 reward、过程 invariant、simulator error 分开；`pass^k` 表示连续 k 次都成功，不是至少成功一次。
- 2 成功/2 失败的 4 条固定 Trial 中，`pass^4=0`；有限样本估计必须声明 trial 数。
- 常见错误：把 gold actions 当唯一合法轨迹；混用不同 task/grader revision 的成绩。

## 第 8 章 综合实践

- `RunManifest` 固定 Subject/Dataset/Environment/Grader/Simulator 版本。
- `TrialRecord` 保存一次执行；`ScoreRecord` 保存 grader、判断、理由和 evidence references。
- MVP 必须能沿 `run_id → trial_id → score → evidence` 反向追踪。
- 常见错误：把 score 塞进 TrialRecord 却不保存 grader version；一个平均总分抵消安全或 Outcome 失败。
