# 资料：Agent Runtime 与工作流设计

> 本包的核心结论优先引用来源拥有者的文档或工程文章。链接指向当前官方页面；框架 API 会演进，阅读时应同时记录版本与访问日期。

## 工具、循环与执行边界

| 来源 | 用于说明 | 类型 |
|---|---|---|
| [smolagents Tools](https://huggingface.co/docs/smolagents/main/tutorials/tools) | Tool 的元数据、`@tool`、工具箱管理 | 官方文档 |
| [smolagents Agents / AgentMemory](https://huggingface.co/docs/smolagents/main/reference/agents) | 多步 memory 和 replay | 官方文档 |
| [smolagents Secure code execution](https://huggingface.co/docs/smolagents/main/tutorials/secure_code_execution) | local executor 不是强隔离边界 | 官方文档 |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | function tools、schema validation、tracing | 官方文档 |
| [OpenAI Agents SDK: Running agents](https://openai.github.io/openai-agents-python/running_agents/) | runner loop 与工具执行 | 官方文档 |

## 控制、审批与持久状态

| 来源 | 用于说明 | 类型 |
|---|---|---|
| [OpenAI Agents SDK: Guardrails](https://openai.github.io/openai-agents-python/guardrails/) | input/output/tool guardrail 的位置与边界 | 官方文档 |
| [OpenAI Agents SDK: Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/) | pending tool call、RunState、approve/reject/resume | 官方文档 |
| [LangGraph Graph API overview](https://langchain-ai.github.io/langgraph/how-tos/state-reducers/) | state、node、edge、conditional routing | 官方文档 |
| [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | checkpoint、thread、故障恢复、pending writes | 官方文档 |

## 上下文、harness 与安全

| 来源 | 用于说明 | 类型 |
|---|---|---|
| [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | context 是有限资源，需每轮策展 | 官方工程文章 |
| [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/) | 将边界、反馈、可验证性编码到环境 | 官方工程文章 |
| [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/) | 目标劫持、工具误用、权限滥用、RCE、context poisoning | 行业安全指南 |

## 阅读方法

1. 将一个框架的 API 行为标为“框架事实”，不要自动推广为所有 Agent 的必然规律。
2. 将跨框架不变量（最小权限、结构化 state、幂等、可观测性）标为“设计归纳”。
3. 不把教学伪代码当作上游源码；真正实现前应根据当前 SDK 版本复核。

## 相关笔记

- [00-学习索引](<./00-学习索引.md>)
- [AI Agent 设计与源码研究（2026）](<../AI Agent 设计与源码研究（2026）/README.md>)
- [AI Agent Evaluation](<../AI Agent Evaluation/README.md>)
