# Agent Learning Lab

This context defines the language used to design small Agent projects whose primary purpose is learning Agent engineering through implementation and testing.

## Language

**Learning Coverage**:
The range of Agent engineering mechanisms that a project makes observable, implementable, and testable. It takes priority over product novelty and broad feature completeness in the first project.
_Avoid_: Feature coverage, product completeness

**Evidence Research Agent**:
The first learning project: an Agent that investigates a bounded technical question, maintains traceable evidence, and produces a verified learning artifact. It is a vehicle for learning Agent engineering rather than a general-purpose research product.
_Avoid_: Deep research platform, chat tutor, general research assistant

**Research Run**:
A bounded investigation initiated from one technical question and an explicit local source scope. It may remain active or suspended, or end as completed with a published Learning Artifact, cancelled, or failed.
_Avoid_: Chat, conversation, session

**Run Operation**:
One command-owned attempt to advance or mutate a Research Run, protected by a per-run durable lease while asynchronous model or tool work occurs. The lease establishes operation ownership but never replaces Run Journal facts.
_Avoid_: Research Run, tool call, database transaction

**Suspended Run**:
A non-terminal Research Run that is durably waiting for approval, user continuation, or another recoverable condition. It may resume from its existing Run Journal.
_Avoid_: Cancelled Run, failed run

**Cancelled Run**:
A terminal Research Run that must never resume or start new work. Continuing its investigation requires a new Research Run that explicitly references reusable prior evidence.
_Avoid_: Suspended Run, paused run

**Research Loop**:
The bounded agentic phase inside a Research Run in which the model chooses what local material to search or read next and which evidence gaps to pursue. Approval, validation, persistence, and publication remain outside this loop.
_Avoid_: Workflow, autonomous run

**Research Tool**:
A narrow model-visible capability for inspecting approved local sources or proposing structured research state. Governance actions, validation, publication, arbitrary file writes, and shell execution are not Research Tools.
_Avoid_: Runtime command, permission, shell command

**Source Scope**:
The versioned set of canonical local roots, exclusions, text limits, and content rules that a plan approval authorizes for one Research Run. Every discovered and requested path is revalidated by realpath containment before access.
_Avoid_: Working directory, glob, filesystem permission

**Run Journal**:
The append-only, ordered record of committed semantic events for a Research Run. It is the canonical source for recovery and explanation.
_Avoid_: Chat history, log file, mutable run state

**Run Trace**:
A human- or machine-readable projection of a Run Journal that exposes the ordered model, tool, approval, validation, budget, and recovery activity of a Research Run. It may be filtered or reformatted and is not itself canonical state.
_Avoid_: Run Journal, Learning Artifact, application log

**Run Projection**:
The current operational state derived deterministically from a Run Journal. It may be cached or rebuilt and never becomes the canonical source of facts.
_Avoid_: Run Journal, model context

**Model View**:
The budgeted, replaceable context derived from the Run Journal, Run Projection, and referenced artifacts for one model call. Compression may change this view but cannot change canonical run facts.
_Avoid_: Canonical history, Run Projection, messages database

**Model Turn**:
One completed, provider-neutral model generation containing normalized text, tool intents, finish reason, and usage. Partial provider stream deltas are observable but do not become canonical model output until the turn completes.
_Avoid_: Provider response, Research Loop, chat message

**Scripted Model**:
A deterministic Model Port implementation that returns a predefined sequence of Model Turns for runtime and recovery tests. It tests the Harness without introducing live-model variance.
_Avoid_: Mock response, evaluator model, test prompt

**Fault Injection Point**:
A named, deterministic boundary where a test can interrupt execution before or after a durable transition or external effect. Restarting from that boundary must demonstrate the specified recovery behavior.
_Avoid_: Random failure, thrown test error, provider failure

**Run Budget**:
The approved, multi-dimensional limit on model turns, tool calls, distinct sources, source bytes, and wall time for one Research Run. Exhaustion suspends the Run without success; a new approved budget version may resume it, while cancellation makes it terminal.
_Avoid_: Token limit, timeout, model-controlled budget

**Artifact Store**:
The local content-addressed store for large immutable payloads referenced by Run Journal events, such as source snapshots, tool results, plans, and drafts. SQLite stores artifact metadata and stable references rather than duplicating these payloads in events.
_Avoid_: Run Journal, output directory, mutable workspace

**Runtime Home**:
The private, untracked local directory containing the SQLite database and internal Artifact Store for Research Runs. It is not a publication target and must not contain persisted credentials.
_Avoid_: Output Root, workspace, cache directory

**Output Root**:
The canonical directory within which approved Learning Artifacts may be published. A Publication Approval binds an exact target realpath inside this root.
_Avoid_: Runtime Home, Source Scope, working directory

**Source Snapshot**:
An immutable, content-hashed view of an allowed local source at the moment it was inspected during a Research Run. Evidence remains attached to this version even if the workspace file later changes.
_Avoid_: Live file, source link

**Evidence Record**:
A traceable reference to an exact range within a Source Snapshot, including the tool call that collected it. It supports Claims but is not itself a conclusion.
_Avoid_: Citation text, source file, Claim

**Evidence Gate**:
The deterministic publication gate that validates source scope, hashes, exact ranges, tool-call lineage, Claim classification, references, authorization, and budget compliance. A failed Evidence Gate cannot be overridden by an evaluator model.
_Avoid_: Evaluator Review, LLM judge, user approval

**Claim**:
An atomic statement intended for a Learning Artifact and classified as a source fact, inference, or design recommendation. A Claim must satisfy the evidence rules for its classification before publication.
_Avoid_: Evidence, paragraph, model assertion

**Evaluator Review**:
An advisory, independently prompted model assessment of whether each Claim is supported, partial, unsupported, contradicted, or uncertain given only its cited evidence. It produces review evidence for the user but cannot mutate research facts or authorize publication.
_Avoid_: Evidence Gate, fact checker, publication approval

**Approval Receipt**:
A durable record that authorizes one exact version and scope, identified by stable IDs and hashes. Plan approval and publication approval are separate receipts; neither grants blanket permission to changed content, expanded sources, or a different target path.
_Avoid_: Approved flag, user confirmation, permanent permission

**Publication Effect**:
The durable, content-addressed action that writes one approved Learning Artifact to one approved target path. Its lifecycle distinguishes pending, executing, succeeded, unknown, and conflicting outcomes so recovery never blindly overwrites or replays a write.
_Avoid_: File save, write tool, publication approval

**Learning Artifact**:
The approved Markdown report produced by a Research Run, containing traceable conclusions, an Evidence Index, and a compact tool-usage summary. Full tool arguments, results, and runtime transitions remain in the separate Run Trace.
_Avoid_: Final answer, chat response, transcript
