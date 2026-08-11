# AI Agent Evaluation 源码与实践课程

这是一套从“评价对象是什么”逐步走向 metric、生产证据、可复现 harness 和动态交互 benchmark 的中文课程。最终目标是独立建立一套能发现回归、解释失败、约束发布并持续吸收线上样本的 Agent 评价系统。

## 从这里开始

先阅读[学习路线与章节目录](00-learning-guide.md)。主线是：

```text
评价共同语言
  → DeepEval：测试原语与 Trace Metric
  → Ragas：Metric Engineering 与 Judge 校准
  → Langfuse / Phoenix：生产回流与开放证据（并列案例）
  → Inspect AI：Harness、Sandbox 与可复现运行
  → τ-bench：动态用户、环境终态与 pass^k
  → 核心综合实践：建立自己的 Agent Eval System
```

## 正文章节

### 第一部分：定义测量对象

1. [AI Agent 评价方法论：从答案评分到系统验证](01-AI-Agent-评价方法论.md)

### 第二部分：学习评价器与测试原语

2. [DeepEval：Case、Trace、Metric 与 CI Gate](02-DeepEval-方案详解.md)
3. [Ragas：Metric、Experiment 与 Judge Alignment](03-Ragas-方案详解.md)

### 第三部分：把生产行为变成评价证据

4. [Langfuse：Observation、Score 与生产回流](04-Langfuse-方案详解.md)
5. [Phoenix：OpenInference、Annotation 与 Evaluator Trace](05-Phoenix-方案详解.md)

### 第四部分：运行可复现的 Agent 试验

6. [Inspect AI：Task、Harness、Sandbox 与 EvalLog](06-Inspect-AI-方案详解.md)
7. [τ-bench / τ³-bench：动态用户、终态与可靠性](07-Tau-Bench-方案详解.md)

### 第五部分：核心综合实践

8. [构建一个最小可信 Agent Evaluation System](08-capstone-agent-eval-system.md)

## 每章怎样学习

不要以“这个平台有什么功能”为主线。每章都要回答：

- 被测 Subject 如何版本化？
- Task 的初始状态、成功终态和禁止副作用是什么？
- 一次 Trial 保存了哪些 outcome、trajectory 和环境证据？
- Grader 使用确定性规则、LLM judge 还是人工标注，如何校准？
- 随机性怎样通过多 Trial、slice 和不确定性报告表达？
- 什么条件进入 CI，什么条件只用于诊断或生产观察？

第 1–6 章使用同一份[Support Ticket Agent 贯穿案例](CASE-STUDY.md)，完成练习后到[答案与判分点](SOLUTIONS.md)校准。

## 研究与参考

以下内容用于横向查证，不挡在主线之前：

- [附录 A：六大方案能力对比与组合边界](appendix-a-六大方案对比与选型.md)
- [附录 B：权威论文与近期评价方法综述](appendix-b-权威论文与近期方法综述.md)
- [附录 C：评价参考架构与场景化总结](appendix-c-Agent-评价综合参考.md)
- [附录 D：平台版本、许可与部署维护卡片](appendix-d-platform-maintenance-cards.md)
- [外部资料索引：Agent评测漫谈](THIRD_PARTY_SOURCES.md)

## 证据边界

- 框架存在某项能力，不等于评价设计已经有效；
- LLM judge 输出不是 ground truth，必须用人工金标校准；
- 公开 benchmark 结果不能代替自有任务、真实工具和生产分布；
- 本课程中的项目状态、许可证和版本信息用于固定实验边界，不决定学习顺序。
