# AI Stuff

一组围绕 AI Agent、Agent Evaluation、聊天界面交互与流式 Markdown 的中文源码研究和工程笔记。

## 内容

| 目录 | 主题 |
|---|---|
| [Agent Runtime 与工作流设计](<Agent Runtime 与工作流设计/00-学习索引.md>) | Agent loop、Harness、工具契约、状态、副作用、安全与可观测性 |
| [AI Agent Evaluation](<AI Agent Evaluation/README.md>) | Agent 评价方法、评测框架、生产证据与动态 benchmark |
| [AI Agent 设计与源码研究（2026）](<AI Agent 设计与源码研究（2026）/README.md>) | 主流 Agent SDK、runtime、coding agent 与多 Agent 框架源码研究 |
| [Bubble List 自动滚动源码学习](<Bubble List 自动滚动源码学习/README.md>) | 聊天消息列表的自动滚动、跟随状态与浏览器竞态 |
| [流式 Markdown 渲染器源码学习](<流式 Markdown 渲染器源码学习/README.md>) | 流式 Markdown 渲染器、兼容性与增量渲染设计 |

## 资料边界

- 架构结论尽量追踪到官方文档或固定提交源码。
- 教学伪代码和等价重写用于解释控制流，不代表上游逐字实现。
- 社区数值和版本信息都是时间点快照，应结合文档中的日期阅读。
- 外部文章、图片和其他第三方材料只有在许可明确时才会直接收录；否则只保存来源链接和研究笔记。
- 仓库当前没有附加开源许可证。除非文件另有说明，不应推断获得了复制、修改或再发布授权。

## 从 Obsidian Vault 同步

仓库保留 GitHub 友好的公开副本，原始笔记仍可在 Obsidian Vault 中维护。

```bash
AI_NOTES_VAULT_ROOT="/path/to/your/vault" ./scripts/sync-from-vault.sh
```

同步脚本会：

1. 复制指定的五个知识目录；
2. 排除没有明确再发布许可的第三方全文和图片；
3. 把已知 Obsidian wikilinks 转成 GitHub 可用的 Markdown 链接；
4. 运行公开信息扫描。

提交前仍应人工检查 `git diff`。
