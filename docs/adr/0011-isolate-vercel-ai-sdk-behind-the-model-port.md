# Isolate Vercel AI SDK behind the Model Port

The first provider adapter uses Vercel AI SDK Core `streamText` and `@ai-sdk/openai-compatible` for one model generation, provider transport, streaming, schema handling, cancellation, usage, and normalized errors. Tools have no AI SDK `execute` functions, and the project does not use `ToolLoopAgent`, `stopWhen`, automatic multi-step execution, `useChat`, or AI SDK message history as runtime state; all AI SDK types are normalized behind the project's Model Port before anything enters the Run Journal.

This boundary preserves the provider integration benefits documented by [AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [`streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text), and the [OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) without delegating the Agent loop or recovery protocol.
