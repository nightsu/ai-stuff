# Expose command-oriented runtime boundaries

CLI and future interfaces drive the headless runtime through explicit application commands for creating, advancing, approving, suspending, cancelling, reconciling, inspecting, and tracing Research Runs. Domain reducers and policies remain pure, infrastructure implements narrow ports, and AI SDK, SQLite, filesystem, and search-library types never leak into the public runtime API, preventing interface adapters from reimplementing or bypassing the state machine.
