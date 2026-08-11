# Represent Research Run state as a discriminated union

The Run Projection uses one discriminated state carrying the identities required for its legal continuation, rather than independent phase, status, approval, and error flags that can form impossible combinations. Completed, cancelled, and failed are irreversible terminal states; approval waits, evaluator resolution, publication ambiguity or conflict, user pause, and budget exhaustion remain explicit suspended states, with the reducer as the only authority that applies transitions or rejects illegal events.
