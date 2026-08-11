# 附录 D：平台版本、许可与部署维护卡片

本附录集中保存会随版本变化、但不应阻塞第一次学习的项目事实。正文只保留会改变 API 或评价结论的边界。

| 平台 | 主线教学主题 | 维护时重点复核 |
|---|---|---|
| DeepEval | Case、Trace/Span、Metric、CI gate | OSS 与 Confident AI 边界、trace/online eval 能力、许可证 |
| Ragas | single-aspect metric、Experiment、judge alignment | v0.4 与 legacy API、外部 tracing、合成数据能力 |
| Langfuse | production Observation、Score、Dataset 回流 | Core/EE 功能、Cloud/自托管部署、retention 与迁移 |
| Phoenix | OpenInference、Annotation、Evaluator Trace | Phoenix OSS 与 Arize AX、ELv2、online scheduler 边界 |
| Inspect AI | Harness、Sandbox、EvalLog | Python/框架版本、sandbox 镜像、模型 provider 与 registry |
| τ-bench / τ³-bench | 动态用户、终态 oracle、`pass^k` | 当前仓库、task/grader revision、版本修复与旧成绩隔离 |

维护项目时应重新核查官方仓库、发布说明、许可证文本和部署文档；不要把本附录的历史快照当作永久产品事实。
