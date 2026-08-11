# Allow one durable operation per Research Run

Each mutating CLI command acquires a short-transaction, per-run durable operation lease with identity, heartbeat, and expiry, while different Runs and read-only inspection may proceed concurrently. Database transactions never remain open across model or tool I/O; expired leases trigger journal-based recovery, and cancellation is a separate durable control request that may signal the active operation or be consumed by the next recovery command, preventing a lease from becoming an alternative source of run truth.
