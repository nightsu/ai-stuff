# Separate private runtime state from published output

SQLite, internal artifacts, temporary effects, and raw model activity live in an ignored Runtime Home, while only explicitly approved Learning Artifacts may be written beneath an Output Root. Provider credentials are environment-only and never enter journals, traces, approvals, artifacts, or errors; persisted run identity retains only non-secret provider, model, adapter, prompt, and tool-schema versions needed for reproducibility.
