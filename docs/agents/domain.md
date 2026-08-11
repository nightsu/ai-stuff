# Domain Docs

工程技能在探索和修改本仓库前，应按以下规则读取领域文档。

## Before exploring

- 读取仓库根目录的 `CONTEXT.md`。
- 如果以后出现 `CONTEXT-MAP.md`，则按照其中的指引读取相关 context。
- 阅读 `docs/adr/` 中与当前任务相关的 ADR。

如果这些文件不存在，静默继续。不要预先创建空文档；由 `/domain-modeling`、`/grill-with-docs` 或架构改进流程在真正形成术语或决策时按需创建。

## Layout

本仓库使用 single-context：

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-example-decision.md
│       └── 0002-another-decision.md
└── ...
```

## Vocabulary

命名领域概念、issue、测试和设计时，应使用 `CONTEXT.md` 中定义的术语，不随意替换成近义词。

如果需要的概念尚未定义，应重新检查它是否属于项目领域；若确实缺失，交给 `/domain-modeling` 处理。

## ADR conflicts

如果建议与现有 ADR 冲突，必须明确指出，不得静默覆盖：

> Contradicts ADR-0007 (...) — but worth reopening because...
