# Session reasoning workspace and compaction checkpoint

[中文](session-reasoning-workspace-and-compaction-checkpoint.zh-CN.md) · [Terms used](session-reasoning-workspace-and-compaction-checkpoint.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Session reasoning workspace and compaction checkpoint

Long sessions need a small, explicit scratchpad because ordinary context
compaction can preserve conclusions while losing the evidence path, rejected
hypotheses, and next action. NMG Lab therefore provides a
`ReasoningWorkspace`. It is not another persistent memory graph and it is not
raw hidden chain-of-thought. It is session-local, auditable state projected
through the Active Graph boundary.

The workspace records only concise typed items:

```text
goal | observation | hypothesis | evidence | conclusion
decision | open_question | next_action
```

and explicit relations:

```text
supports | contradicts | derived_from | tests
rejects | depends_on | next_step
```

Harness integration follows one daemon-owned lifecycle:

```text
model or tool result
  -> existing NMG client: lab enable/invoke
  -> daemon-owned <NMG_DATA_DIR>/lab/reasoning/<session-hash>.json
  -> bounded ReasoningCheckpoint
  -> optional harness injection after its normal compaction
```

NMG does not replace Pi's compactor. `session_before_compact` only marks the
workspace for a later checkpoint, while `before_agent_start` consumes and injects
at most a fixed node and character budget. Each checkpoint line carries both lifecycle status and a structural
support state: `referenced`, `linked`, or `unsupported`. Hypotheses retain their
status and unsupported hypotheses remain explicitly marked rather than being
presented as established facts.
Rejected paths are kept when useful so the model does not repeat disproven
work.

Only supported, high-importance conclusions or decisions with traceable
evidence are eligible for later LTG consolidation. New `evidence` nodes require
at least one non-empty evidence-reference string; this prototype does not resolve
the string or verify that its target is stable or external. The `add` and `update`
operations permit a node to have status `supported` only when it has a reference
itself or an incoming `supports`/`derived_from` path whose source is transitively
reference-anchored; cycles cannot manufacture support. Restoring a hand-edited
state file does not re-run that check. Removing a reference through `update` is
rejected when it would orphan an already supported downstream node. NMG retains
reference identifiers for audit but does not claim that the scratchpad
independently verified the referenced source.
The current prototype merely
reports those candidates; it does not automatically promote scratch state into
long-term memory.

Within one session, `add` is retry-idempotent for an exact normalized
`kind + content` pair. A repeated call reuses the existing node without merging
new status, importance, or evidence; semantic evolution and additional evidence
must use explicit `update`. This prevents tool retries from inflating the graph
while keeping changes auditable.

Scratch lifecycle is deliberately session-bound. The same Agent session can resume
its atomic file after a process restart; a new session never inherits another
session's workspace automatically. `clear` deletes the owning session
immediately. Because the scratchpad is not durable semantic memory, maintenance
may remove workspace JSON files whose filesystem modification time is older than
30 days, along with an associated pending compaction marker. Reads and checkpoint
consumption do not refresh that timestamp. Cross-session task transfer, event
archive, and STG/LTG promotion require a future explicit reviewed operation;
cleanup must never imply that a conclusion was accepted or forgotten from LTG.

`nmg_lab` is a stable capability-discovery entry on the existing NMG client in
Pi, MCP, DSH, and the CLI; it is not a second process or client library. An Agent
may obtain a bounded session lease for `reasoning_workspace`,
`memory_graph_reasoner`, or `controller_shadow`, invoke only the operations listed
by `lab list`, and disable the lease when finished. Leases expire automatically.
`controller_controlled` and `controller_active` accept no Agent self-authorization:
the existing candidate, evaluation, receipt, rollback, and product gates remain
mandatory. Project/global self-service is intentionally unsupported.

The daemon owns Lab state and performs atomic reasoning-workspace writes. Pi may
still expose the convenience `nmg_reason` schema under
`NMG_ENABLE_LAB_TOOLS=1`, but that tool now delegates to the same daemon `lab`
RPC. `session_before_compact` records a one-shot marker only when the session
capability is active, and the next `before_agent_start` consumes one bounded
checkpoint. MCP, DSH, or another harness can use the same state without importing
Pi code. Lab output never enters STG/LTG unless separately submitted through the
governed remember boundary.

A historical automatic input-capture and checkpoint-injection variant is
recorded as implemented and rejected in July 2026. In a matched DeepSeek V4 Flash development run (three
tasks, three repeats), the full-context baseline and automatic variant both
scored 100%, but mean latency increased from 7.0 s to 9.8 s. After normal Pi
compaction, the baseline scored 100% while automatic injection scored 77.8% and
increased mean latency from 11.9 s to 15.7 s. Explicit `nmg_reason` calls were
slower still; local tool execution accounted for only about 0.1--0.2 s, showing
that extra model rounds, not local graph operations, dominated the cost.

Therefore NMG does not automatically parse every user turn into the reasoning
workspace and does not inject that workspace on ordinary turns. The scratchpad
remains an explicit Lab capability for tasks that need an auditable reasoning
checkpoint. One-call correctness should instead come from the stable harness
layers: bounded resident context, gated long-term recall, provenance-aware
retrieval, and progressive evidence expansion only when the first retrieval is
insufficient.
