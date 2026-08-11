# Store run data in SQLite and large artifacts by content

The local MVP stores Run Journal events, projections, action state, approvals, evidence indexes, and artifact metadata in SQLite, while large immutable payloads live in a content-addressed local Artifact Store. SQLite provides the transactional boundary needed to append an event and update its cached projection atomically without introducing the operational burden of a server database; JSONL remains an export format rather than the canonical store.
