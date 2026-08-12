# Publish Learning Artifacts as reconcilable durable effects

Writing an approved Learning Artifact is modeled as a durable Publication Effect keyed by the run, approved draft hash, and target path, with pending, executing, succeeded, unknown, and conflict outcomes. The executor writes through a same-directory temporary file and atomic no-clobber publication (currently a hard-link), while recovery reconciles the target content hash before retrying; it never overwrites different existing content or treats an ambiguous crash window as ordinary failure.

Implementation status: Issue #5 deliberately delivers only the normal no-clobber publication path. It records `learning_artifact_published` only after a successful return and never infers completion after a crash; automatic replay/reconciliation is prohibited in that slice. Issue #14 must add the full durable effect lifecycle described above before this ADR is considered implemented end-to-end.
