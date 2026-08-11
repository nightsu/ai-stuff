# 第 8 章 核心综合实践：构建最小可信 Agent Evaluation System

> 分层先修：完成第 1–2 章即可做 MVP；第 3 章增加 judge calibration；第 4–5 章增加生产 evidence；第 6–7 章增加 harness、动态用户与可靠性。完整毕业线要求第 1–7 章。

## 本章要解决的问题

怎样把 Subject、Task、Harness、Evidence、Grader、多次 Trial、CI 与生产回流连接成一条闭环，并证明失败来自 Agent 而不是评价系统自身？

## 本章目标

默认使用[贯穿案例](CASE-STUDY.md)，也可以替换成自己的两工具 Agent。围绕它逐层建立：

- 版本化 Subject；
- 分层 Task Suite；
- 可重置 Harness；
- 完整 Trial Evidence；
- 多类 Grader；
- 多 Trial 统计；
- CI Gate；
- 生产失败回流。

## 本章练习：1. 定义 Evaluation Subject

```python
@dataclass(frozen=True)
class SubjectVersion:
    model: str
    system_prompt: str
    tool_schema: str
    orchestrator: str
    memory_policy: str
    agent_runtime_revision: str
```

任何字段改变都生成新版本。报告不能只写“模型 A 对比模型 B”。

## 写 Task Contract

```python
@dataclass
class TaskContract:
    task_id: str
    revision: str
    initial_state: dict
    user_goal: str
    success_invariants: list[str]
    forbidden_effects: list[str]
    max_steps: int
    max_cost: float
    reference_solution: str
```

每个任务必须有已知可通过解，用来证明环境和 grader 没有自相矛盾。

## 分开保存 Run、Trial 与 Score

```python
@dataclass(frozen=True)
class RunManifest:
    run_id: str
    subject_version: SubjectVersion
    dataset_revision: str
    eval_harness_revision: str
    environment_fixture_revision: str
    grader_versions: dict[str, str]
    simulator_version: str | None
    dependencies: dict[str, str]

@dataclass
class TrialRecord:
    run_id: str
    trial_id: str
    task_id: str
    task_revision: str
    seed: int
    transcript: list[dict]
    tool_calls: list[dict]
    state_before: dict
    state_after: dict
    timing: dict
    usage: dict
    errors: list[dict]

@dataclass
class ScoreRecord:
    trial_id: str
    grader_id: str
    grader_version: str
    score: float | bool
    verdict: str
    reason: str
    evidence_refs: list[str]
```

`RunManifest` 固定实验谱系，`TrialRecord` 保存一次执行，`ScoreRecord` 说明哪个 grader 基于哪些 evidence 产生了哪个判断。最终文本只是 evidence 的一部分。

## 组合四类 Grader

### Outcome oracle

直接检查数据库、文件、测试或环境状态。硬事实优先使用确定性程序。

### Process rule

检查必须/禁止动作、批准、工具参数、重复副作用和预算。

### LLM judge

只负责难以确定性表达的完整性、解释质量或开放式轨迹合理性。rubric 必须 single-aspect、结构化并版本化。

### Human calibration

MVP 可以暂不启用 LLM judge。Metric 扩展先用 8 条人工 labels 验证方向；生产门禁前再扩展到至少 30 条盲评，并记录人类分歧与 agreement。

## 设计组合判定

```python
def verdict(scores):
    if scores.safety_violation:
        return "fail"
    if not scores.outcome_success:
        return "fail"
    if scores.regression_case_failed:
        return "fail"
    if scores.judge_calibrated and scores.semantic_quality < 0.8:
        return "review"
    return "pass"
```

安全和关键 Outcome 不能被平均分抵消。诊断指标与发布门禁必须分开。

## 运行多 Trial

MVP 每个 Task 运行 3 次；可靠性扩展至少 5 次。保存 seed 与完整配置，并按阶段报告：

- pass@1；
- pass@k；
- pass^k；
- 每类 Task 的 slice；
- 成本、延迟和工具次数分布；
- Agent、environment、grader、simulator 四类失败。

不要只报告一个平均总分。

## 构造分层 Suite

| Suite | 最小内容 | 运行频率 |
|---|---|---|
| Smoke | 5–10 个核心可用性任务 | 每次提交 |
| Regression | 已修复失败与关键业务 | 每个 PR |
| Capability | 困难、长程、低通过率任务 | 定期 |
| Safety | 越权、注入、拒绝、危险副作用 | 重要版本 |
| Production replay | 去敏线上成功/失败样本 | 持续抽样 |

## 自测评价系统

至少注入以下故障：

1. grader 错把合法替代路径判失败；
2. environment 没有 reset，前一 Trial 污染后一 Trial；
3. LLM judge prompt 改版导致阈值漂移；
4. user simulator 拒绝提供任务必需信息；
5. benchmark task 本身不可解；
6. trace 丢失一个 tool result；
7. Agent 声称成功但环境终态错误。

评价系统必须能把这些故障与 Agent failure 分开。

## 接入 CI 与生产回流

- CI 固定 Subject、Dataset、Environment、Grader 和依赖版本；
- 关键安全/Outcome 失败直接阻断；
- 统计波动使用阈值与置信区间，不因单次 lucky run 放行；
- 生产 trace 经过隐私处理和人工确认后进入 Regression；
- 新失败模式先增加 Task，再修改 Agent。

## 练习验收

### MVP 毕业线（第 1–2 章后）

- [ ] 一个 Task、一个可重置环境、3 条 Trial；
- [ ] SubjectVersion 足以区分两次实验；
- [ ] RunManifest、TrialRecord、ScoreRecord 可以通过 ID 相互追踪；
- [ ] 每个分数能追到原始 evidence；
- [ ] 环境可以按 Task 重置；
- [ ] Outcome、Process、Safety、Cost 分开报告；

### Metric 与 Harness 扩展

- [ ] Judge 有人工校准结果，并保存 grader version；
- [ ] 每个 Task 运行多 Trial，EvalLog 可以重建失败；
- [ ] pass@k 与 pass^k 没有混用；
- [ ] benchmark/grader/simulator 有自测；

### 生产化扩展

- [ ] CI gate 与诊断指标分开；
- [ ] 线上失败能去敏、复现并进入回归集。

## 检查理解

1. 为什么 Agent 的最终文本不能代表 Outcome？
2. 为什么 Tool Schema/Agent Runtime 属于 SubjectVersion，而 Harness Environment 属于 RunManifest？
3. 哪些指标适合硬门禁，哪些只适合诊断？
4. pass@k 与 pass^k 分别回答什么问题？
5. 如何判断一次失败来自 Agent、环境、grader 还是 simulator？
6. 为什么评价系统本身也需要回归测试？

## 本章小结

可信评价不是把多个分数拼成总分，而是让每个结论都能回到版本化 Subject、可重置环境和完整 Trial Evidence。硬事实、过程约束、语义判断与人工校准各司其职，评价系统本身也必须通过故障注入和回归测试。

---

[上一章：τ-bench / τ³-bench](07-Tau-Bench-方案详解.md) · [课程目录](00-learning-guide.md) · [综合参考架构](appendix-c-Agent-评价综合参考.md)
