# Frame-local maintained AG working state

**Status:** implemented
**Approved:** explicit
**Relates to:** [Maintained-state proposal](../proposed/2026-10-06-ag-state-transitions.md)

中文版: [2026-10-08-ag-working-state.zh-CN.md](2026-10-08-ag-working-state.zh-CN.md)

## Problem

Content-hashed observations accumulate revisions instead of replacing a current
state. The shared information-output foundation protects display text but does
not supply a current-state writer. A small temporary carrier is needed without
a second store, schema engine, host-specific executor or authority change.

## Decision

Implement only the bounded current-state portion of slice B, following the
[shared-output foundation](2026-10-07-shared-information-output.md). Host-input
selection and benefit evaluation remain separate. This is not completion of
slices A–D or evidence that maintenance reduces model cost.

- Each existing `FrameState.items` has at most one `working_state`, with fixed
  frame-local item identity, exact text, content hash and captured binding
  provenance. Replace does not append another item. It is provisional working
  content, not hidden reasoning, semantic memory or collaboration acceptance.
- Dedicated runtime bind/replace/clear methods own writes. Generic `observe`
  rejects this kind. Identical text is `unchanged`; successful replacement is
  `updated`; clear is idempotently `cleared`. These acknowledgements do not echo
  the text, certify correctness or create disclosure/learning evidence.
- Validate binding, nonblank text, the existing secret-pattern policy, state
  ceiling and aggregate resident capacity before mutation. Rejected writes
  preserve old text and other content; no truncation or eviction is used to
  claim a successful state write. The ceiling cannot exceed either resident
  capacity or the 8,000 UTF-16-code-unit preparation budget minus the temporary
  label and separator. Smaller configured state ceilings are allowed.
- State participates in the existing active-plus-cooled resident item/character
  caps but is protected from ordinary-item eviction. It can therefore reduce
  retrieval/observation capacity. Explicit clear, frame/session eviction,
  release and process restart remove it. Clearing visibility does not.
- Trusted callers capture `{sessionId, agId, taskFrameId, bindingId}`. A write
  must still match the graph incarnation, active frame and current binding.
  Switching, rebinding or releasing fences already-captured operations. A
  binding is context metadata, not authentication or permission by itself;
  the existing trusted daemon/client boundary still applies.
- Existing `nmg_lab` discovers a session-only, self-service `working_state`
  lease with exactly `replace(input={text})` and `clear(input={})`. Model-facing
  input cannot select a frame or patch arbitrary data. Service enablement
  captures the binding; ordinary clients attach it outside model input before
  transport and never refresh a supplied fence on retry. Raw RPC callers must
  provide captured metadata. Disable/expiry removes write permission, not text.
- Current adapters use an explicit **session working frame** while enabled.
  Search query changes freeze new projections in that same frame; observations
  without explicit frames use the current frame. This is a documented fallback,
  not semantic task detection or an adapter A→B→A restoration promise. Library
  callers can bind actual trusted task frames without model-selected identity.
- Shared AG surface preparation admits current state with the temporary label,
  even before ordinary temporary observations are activated. It still applies
  whole-item output omission. Preparation is not proof of actual model input.
  Ordinary tools, JSON/RPC and library consumers need no Pi/codemode dependency,
  new tool, executor or extra output call.

## Consequences

The existing owners remain `src/core/session-active-graph.ts`,
`src/integration/lab-capabilities.ts`, `src/cli/protocol.ts`/`service.ts`, and the
ordinary daemon/CLI transport clients. `agent-surface.ts` projects state; prompt
changes belong only to `src/prompts/nmg-prompts.yaml` and its generator. Pi, MCP
and DSH remain thin tool registrations; the package exports the runtime binding
and ordinary client helper.

Deterministic regressions cover replacement identity, exact long text and
hash changes, unchanged/clear, blank/secret/oversize refusal, aggregate-budget
refusal preserving content, ordinary-item protection, session/frame isolation,
rebind/recreation/eviction fencing, visibility clearing without state deletion,
Lab discovery/opt-in, restricted operation input, query-stable fallback,
client-side capture without retry refresh and short acknowledgement rendering.
No live LLM, embedding request or memory benchmark establishes benefits here.

## Deferred

- Actual per-inference exposure confirmation and output-to-ledger commitment.
- Reliable semantic task identity, adapter task-frame restoration and concurrent
  writers; the initial owner update path remains serial.
- Pi per-turn state carriage is implemented separately in the
  [carriage slice](2026-10-08-ag-working-state-input.md). Other hosts have no
  equivalent carriage path yet; final provider confirmation and
  protected-history rewriting are not supplied by either slice.
- One combined dynamic-model-input budget, wrapper/write/read cost accounting,
  authorization/version rechecks at exposure and matched continuity/cost tests.
- Durable event archive, task/collaboration authority and semantic promotion;
  those remain independent owners, never consequences of maintenance.

## Alternatives considered

- Hash each revised observation: rejected; old versions remain live rather than
  representing one current value.
- Add a schema/JSON-patch engine or separate state/workspace store: rejected;
  full text replacement and existing frame lifetime suffice for this slice.
- Let model parameters choose ownership or refresh a stale fence: rejected;
  delayed content must not borrow another activation's context.
- Infer tasks from query hashes or board channels: rejected; neither establishes
  trusted semantic task identity. Explicit session fallback is more honest.
- Replace host history or claim model savings in the same change: deferred;
  maintenance, actual visibility and live benefit require different evidence.
