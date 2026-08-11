# Use a Run Journal with derived projections

Each Research Run uses an append-only journal of typed semantic events as its canonical history; operational state, human-readable traces, and budgeted model context are separate projections. This is intentionally limited to the Research Run lifecycle rather than event-sourcing the entire application, preserving recoverability and causal evidence without making mutable snapshots or compressed model messages the source of truth.

Large plans, tool results, evidence payloads, and drafts are stored as artifacts referenced by stable IDs rather than copied into every event. A current-state projection may be cached for efficient execution, but it must remain reproducible from the journal.
