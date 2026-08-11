# AI Agent 设计与源码学习资源

## Knowledge

- [逐章课程路线](agents/00-learning-guide.md)  
  本课程的主入口。用于确定章节顺序、练习与掌握标准。
- [权威论文与近期文章导读](12-authoritative-literature-guide.md)  
  用于补充 ReAct、memory、tool interface、benchmark 和安全等理论背景。
- [AI Agent 综合参考架构](13-integrated-synthesis.md)  
  完成主要章节后使用，用于把各项目机制组合成自己的运行时设计。
- [源码冻结与证据规则](00-methodology.md)  
  当需要复核某个结论、更新源码版本或扩展新项目时使用。

各案例章已经直接链接到对应仓库的固定提交入口；学习时优先从章节给出的 3–7 个入口进入，而不是浏览完整仓库目录。

## Wisdom

- 各上游项目的 GitHub issues、Discussions 或官方社区  
  用于核实真实部署问题、版本迁移和架构限制；在完成相应章节、能够提出具体问题后再进入。

## Gaps

- 目前缺少针对同一任务、同一模型、同一工具集合的跨框架可重复实验；
- 已有[课程实验协议](exercises/README.md)统一 fixture、trace 与故障注入格式，但仍缺少可直接运行的统一自动验收 harness；
- 已提供 [Learning Record 模板](learning-records/_template.md)；实际记录应在学习者完成章节和实验后逐次建立，当前不预先标记完成状态。
