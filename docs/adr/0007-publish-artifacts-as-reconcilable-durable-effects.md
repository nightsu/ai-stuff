# Publish Learning Artifacts as reconcilable durable effects

Writing an approved Learning Artifact is modeled as a durable Publication Effect keyed by the run, approved draft hash, and target path, with pending, executing, succeeded, unknown, and conflict outcomes. The executor writes through a same-directory temporary file and atomic no-clobber publication (currently a hard-link), while recovery reconciles the target content hash before retrying; it never overwrites different existing content or treats an ambiguous crash window as ordinary failure.

Implementation status: implemented end-to-end by Issue #14. The Run Journal records stable PENDING, EXECUTING, UNKNOWN, CONFLICT, and SUCCEEDED facts. Explicit reconciliation revalidates the approval action and safely inspects the target: matching bytes settle without rewriting, missing targets retain the same effect identity for retry, different bytes remain no-clobber conflicts, and inconclusive observations stay UNKNOWN.
