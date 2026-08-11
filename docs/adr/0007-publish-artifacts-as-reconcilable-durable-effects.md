# Publish Learning Artifacts as reconcilable durable effects

Writing an approved Learning Artifact is modeled as a durable Publication Effect keyed by the run, approved draft hash, and target path, with pending, executing, succeeded, unknown, and conflict outcomes. The executor writes through a same-directory temporary file and atomic rename, while recovery reconciles the target content hash before retrying; it never overwrites different existing content or treats an ambiguous crash window as ordinary failure.
