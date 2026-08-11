# Require durable Research Run recovery in the MVP

The MVP must persist every meaningful phase transition and resume a Research Run across process restarts without blindly repeating completed tool calls or asking the model to recreate unresolved work. This deliberately accepts more implementation complexity than an in-memory demo so the project can teach suspension, terminal-state semantics, crash recovery, and fault-injection testing as first-class Agent runtime concerns.
