# Own the teaching Harness instead of adopting an Agent framework

The project implements its own Research Loop, typed events, Run Journal and projections, context construction, tool dispatch, budgets, approvals, recovery, durable publication, and Evidence Gate so those mechanisms remain visible and testable. Provider SDKs and ordinary infrastructure libraries may handle model transport, schema validation, SQLite, CLI parsing, and filesystem primitives, but LangGraph, Agents SDK, and similar orchestration frameworks do not own the runtime control flow.
