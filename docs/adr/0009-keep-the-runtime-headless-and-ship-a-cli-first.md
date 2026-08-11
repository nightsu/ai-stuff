# Keep the runtime headless and ship a CLI first

The MVP is a headless TypeScript runtime driven by a thin CLI whose commands perform explicit state transitions and exit, while suspended approvals remain durable rather than blocking a long-lived process. The runtime exposes stable application commands and machine-readable trace output without depending on terminal UI concerns, allowing a future web trace viewer to reuse the same semantics after the Agent loop, recovery, and evidence model are proven.
