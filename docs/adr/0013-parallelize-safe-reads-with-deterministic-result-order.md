# Parallelize safe reads with deterministic result order

Sibling `search_sources` and `read_source` calls may execute with Harness-bounded concurrency after source-ordered preflight, while research-state tools execute sequentially. Completion events retain actual timing in the Run Journal, but tool results are assembled for the next Model View in the model's original tool-call order, so scheduling differences do not change the projected state or subsequent model input.
