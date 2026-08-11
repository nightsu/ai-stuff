# Snapshot only sources the Agent explicitly reads

When `read_source` first observes an approved file revision, the private Artifact Store retains its complete content under a content hash so Evidence Records remain verifiable after workspace changes; search hits alone do not trigger snapshots. File-size limits, Source Scope checks, exclusions, content deduplication, and ignored local storage bound the MVP's storage and privacy cost; reference-aware garbage collection remains a later extension.
