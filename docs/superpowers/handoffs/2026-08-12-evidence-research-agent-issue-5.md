# Evidence Research Agent — Issue #5 Handoff

Date: 2026-08-12

## Current state

- Issue #5, **Evidence-backed learning artifacts**, is complete, reviewed, pushed, and closed: <https://github.com/nightsu/ai-stuff/issues/5>.
- Worktree: `.worktrees/evidence-agent-remaining-tickets`.
- Branch: `codex/evidence-agent-remaining-tickets`, synchronized with `origin/codex/evidence-agent-remaining-tickets` when this handoff was written.
- Issue #6 has deliberately not been started: the user asked to stop after completing and reviewing #5.

## Implementation handoff

The completed Issue #5 execution plan is [2026-08-12-issue-5-evidence-backed-learning-artifact.md](../plans/2026-08-12-issue-5-evidence-backed-learning-artifact.md).

Final Issue #5 commits, in execution order:

- `e9beb02` — `feat: record evidence-backed claims`
- `5c82b62` — `feat: publish approved learning artifacts`
- `9a95838` — `fix: enforce evidence publication boundaries`
- `113436f` — `docs: explain evidence-backed publication`

Read these before starting any follow-up ticket:

- [Evidence Research Agent README](../../../projects/evidence-research-agent/README.md)
- [Architecture](../../../projects/evidence-research-agent/docs/architecture.md)
- [ADR 0005 — Model research as claims over versioned evidence](../../adr/0005-model-research-as-claims-over-versioned-evidence.md)
- [ADR 0006 — CAS-backed evidence artifacts](../../adr/0006-cas-backed-evidence-artifacts.md)
- [ADR 0007 — Publish artifacts as reconcilable durable effects](../../adr/0007-publish-artifacts-as-reconcilable-durable-effects.md)
- [ADR 0017 — Append-only Run Journal and derived projection](../../adr/0017-append-only-run-journal-and-derived-projection.md)

## Important boundaries and decisions

- Evidence identities are trusted, structured data. Model-authored fields may not contain rendered `【Evidence: ...】` citation tokens; citations are rendered only from selected Evidence Records.
- Trace lineage joins an Evidence Record to its observation, Tool Call, and Source Snapshot.
- Publishing is confined to a separately approved Output Root, bound by canonical path and filesystem identity. Publication is no-clobber via hard-link publication.
- The Evidence Gate enforces model turns, Tool Calls, distinct Source Snapshots, source bytes, and draft-generation wall time. Human approval wait time does not invalidate an otherwise approved exact draft.
- A durable crash/effect reconciliation protocol is intentionally out of scope for #5 and remains Issue #14 work. The currently implemented path is `ready_to_publish → publisher → learning_artifact_published`.
- The current runtime uses the intentionally bounded two-call model flow (research plan, then artifact proposal). Search, model-visible Research Tools, and a multi-turn Research Loop are not implemented yet.

## Verification already completed

From `projects/evidence-research-agent`:

```text
pnpm check      # 15 runtime test files / 222 tests; 2 documentation files / 6 tests
pnpm build
git diff --check
```

All commands passed after the final review fixes. Independent specification and standards reviews found no remaining Critical or Important findings; the sole final Minor (a redundant branch) was removed before final verification.

## Suggested skills

- `to-spec` and `to-tickets`: use before starting a newly authorized issue whose design or task breakdown is not already approved.
- `implement` with `test-driven-development`: retain the existing RED → GREEN → focused regression rhythm for implementation.
- `code-review`: run independent specification and standards reviews before declaring a ticket complete.
- `handoff`: use again only when transferring an unfinished or deliberately paused session.

## Recommended next action

Wait for explicit user authorization before beginning Issue #6. Once authorized, inspect the issue and its approved plan first; preserve the #5 boundary that model-visible tools and a multi-turn research loop are new work, not a silent extension of publication.
