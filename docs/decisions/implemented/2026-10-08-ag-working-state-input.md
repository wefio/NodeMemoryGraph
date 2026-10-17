# AG working-state carriage per user turn

**Status:** implemented
**Approved:** explicit
**Relates to:** [Maintained state](2026-10-08-ag-working-state.md)

[中文](2026-10-08-ag-working-state-input.zh-CN.md)

## Problem

A maintained value does not replace old text already in conversational history, so
each turn has to present the current value again. Presenting it again at every
model call of a turn is a different job: it re-sends the same body, moves the
position of the body sent before it, and needs a removal/witness plan to stop the
copies from multiplying. A turn boundary has no such problem — it is already the
place where new context is appended.

## Decision

Carry the state once per user turn through the existing shared preparation
contract and the thin Pi adapter. The user's deployment order stays adapter
first, then load the plugin and use the verified NMG program. This is not final
provider-send confirmation or completion of C.

- `working-state-input.ts` prepares one dedicated provisional body from the
  current daemon snapshot, using the shared complete-body output budget. Metadata
  fences session, AG incarnation, frame, captured binding and content/text hashes.
  It is not authentication. Host metadata is not model-facing text.
- Pi carries that body exactly once per user turn, as a labelled
  `<nmg_working_state>` block inside the same persisted `nmg-context` message
  the host already returns from `before_agent_start`. The extension registers no
  `context` hook: a later model call in the same turn re-sends nothing and no
  earlier position is rewritten or removed.
- The mixed recall projection keeps excluding the state (`includeWorkingState:
false`), so one turn never carries the same value in two shapes.
- A mid-turn need to read the state is served by the history already in the
  session or by the read-only `/nmg state` view. No model-side read-only entry
  point is added.
- Fail closed: an absent, foreign, incomplete or over-budget body contributes no
  block; an owner read failure or a session change during the read leaves the
  turn message without a state body and shows the user view as unavailable.
- Clear/release ends carriage from the next turn on without deleting resident
  content, and disclosure reset never deletes it. Compaction can drop a turn
  message; the next turn carries the current value again, and that is an append,
  not a rewrite of a stored position.

## Consequences

Pi 1.1.0's `before_agent_start` returns a message the host persists, which is
the carriage this decision uses. The per-inference `ExtensionRunner.emitContext`
/ SDK `transformContext` boundary is no longer used for state, and the extension
no longer reads a snapshot RPC per model call. `context_with_system` and
`before_provider_request` can still replace input, and the response event carries
status/headers rather than the final request body; therefore the Pi capability
reports `confirmation: unsupported`, and this slice writes no disclosure ledger,
semantic record or learning evidence. It does not fix the existing semantic-memory
disclosure path.

Contract tests cover the complete current body, budget and foreign-scope
fail-closed behavior, protection of unrelated history, clear, the absence of a
per-inference state hook, per-turn carriage against a real isolated HTTP daemon,
and the refresh of the user view. These checks do not measure final model input,
token savings, cache behavior or continuity. The earlier per-inference variant is
not claimed to have caused provider cache misses: measured provider payloads show
an append-only prefix, and the reported miss pattern is not attributed here.

## Deferred

- Final request/transport observation and exact source-bound confirmation, with
  permission/version rechecks before any output-to-ledger commitment.
- A combined dynamic-input budget and matched model-cost/continuity evaluation,
  including what one repeated per-turn body costs.
- Equivalent carriage for hosts without a persisted per-turn message, reliable
  semantic task identity and A→B→A restoration; the session-frame fallback is
  unchanged.
- Production plugin reload/daemon replacement is a separate safe lifecycle
  operation, not a consequence of a build or a passing adapter test.

## Alternatives considered

- Keep the per-inference selector that removed and re-appended the body at every
  model call: rejected; it re-sends the same body repeatedly inside one turn,
  displaces the previously sent body, and needs a witness plan for a job the turn
  boundary already solves.
- Fold the body into the mixed recall projection instead of a labelled block:
  rejected; the state must also be carried when recall is empty or fails, and it
  must stay distinguishable from recalled evidence.
- Delete mixed `nmg-context` or tool arguments: rejected; state carriage cannot
  discard unrelated constraints, recall or original evidence.
- Add a model-side read-only state tool: rejected; the value already rides in
  history, and a second read path can disagree with what the turn carried.
- Infer final visibility from a prepared message, payload hook or successful tool:
  rejected; subsequent transforms and transport failure remain possible.
- Patch the Pi installation or introduce an NMG provider executor: not part of
  the requested adapter-first path. Unsupported confirmation stays explicit.
