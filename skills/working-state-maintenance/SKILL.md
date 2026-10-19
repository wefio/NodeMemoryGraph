---
name: working-state-maintenance
description: Maintain a compact temporary working state during multi-step work, task changes, handoffs, or recovery. Use when updating current progress, correcting stale status, or when the user asks to 维护工作状态、精简进度、更新当前状态 or continue an interrupted task. Not for durable memory capture or a new task execution engine.
---

# Working-state maintenance

[简体中文](SKILL.zh-CN.md) · [Terms used](SKILL.terms.yaml)

Keep the smallest provisional snapshot that lets a capable reader choose the
next authorized action with the available evidence. A working state is not a
journal, a second task contract, or proof of completion. This procedure works
without reading a task-semantics design document.

## Maintain the current snapshot

1. Reconcile the visible state with the latest user request and completed tool
   results. Reuse what is already available; read an owner or evidence reference
   only to settle a missing or conflicting fact. Replace the old task when the
   request changes; do not carry its pending actions into the new task or invent
   a semantic task identifier. A new request can end a previous wait for input.
2. Check any new completion claim against the actual result: exit status,
   assertions, verification scope, and the relevant owner. A returned tool call,
   live process, or written artifact is not a passing check. Distinguish planned,
   attempted, implemented, verified, and unresolved work. Unknown stays unknown;
   do not expand a targeted pass into a full verification claim.
3. Keep an item only if removing it could change the next action, lose an unmet
   obligation, violate a constraint, or hide evidence needed to resume. Preserve
   necessary exact values, permission boundaries, unresolved assumptions, and
   accessible evidence references. Detailed logs and completed-task history
   belong at their existing owners, not in this snapshot.
4. Rewrite the whole current snapshot rather than appending a progress entry.
   Remove superseded observations, resolved blockers, and irrelevant runtime
   details; retain an unresolved blocker until evidence settles it. A PID or test
   count belongs here only while a current decision depends on it. Do not remove
   a necessary condition merely to meet a line target.
5. Use only the fields the task needs: goal, relevant verified progress, current
   step, next action, blockers, constraints, or evidence. Omit empty fields and
   repeated standing instructions. A small task can use one sentence; no fixed
   template, field count, or length proves sufficiency.
6. Before writing, check whether the reader can identify the next action and its
   limits without the original Agent's private reasoning. Write only when the
   current state materially changes. On completion leave a short result,
   remaining limits, and an evidence entry point, not a deployment narrative.

For NMG, use the existing `nmg_state` AG writer and complete-text replacement.
The shared `memory_policy` owns its activation, completion, and recovery rules.
Read [working-state operations](../nmg-memory/references/optional-capabilities.md#working_state-operations)
only when the operation, binding, or lifecycle needs clarification. Do not put
secrets or hidden chain-of-thought in the state or create another state store.

## Existing task contracts

When a task has a contract or governed lifecycle, its owner determines allowed
moves and authoritative facts. Reference those facts; a status sentence cannot
approve a deliverable, grant a lease, undo cancellation, or unlock dependencies.
Do not create a run, Task IR, or board entry merely to maintain a single-Agent
snapshot. Missing required evidence is a gap, not evidence that nothing happened.

[Task-unit semantics](../../docs/design/task-unit-semantics.md) is optional
background for understanding NMG's governed collaboration, not a prerequisite,
mandatory read, or definition this workflow depends on. Consult the relevant
current owner only when an actual managed task needs its contract interpreted.
No section layout or task-schema fields from that long document are required here.

## Small review cases

- A target check exits 0; full verification has not run. Keep the target scope
  and the remaining required verification, not "all checks passed".
- A probe exits 1 after producing output. Keep the failure or uncertainty, not
  "verified" merely because an artifact or tool response exists.
- A blocker is resolved and the user changes tasks. Drop the old blocker and
  pending actions; retain only constraints and evidence relevant to the new task.
- A long snapshot ends with a necessary permission limit. Preserve that limit
  while removing irrelevant history; shortening by cutting the tail is unsafe.

These are review examples, not executed evaluations or evidence of token savings.
