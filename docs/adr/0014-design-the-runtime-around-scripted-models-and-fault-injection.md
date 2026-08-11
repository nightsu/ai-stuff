# Design the runtime around Scripted Models and fault injection

MVP correctness is proven primarily with a deterministic Scripted Model and named Fault Injection Points around journal transactions, tool lifecycles, approvals, and publication effects; live-model runs form a separate versioned eval suite. This requires clocks, IDs, model transport, storage, tools, and effect boundaries to be injectable from the start, allowing recovery and ordering invariants to be tested without mistaking model variance for runtime correctness.
