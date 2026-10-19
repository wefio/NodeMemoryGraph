# State spaces and one state entry

[中文](state-spaces.zh-CN.md) · [Terms used](state-spaces.terms.yaml)

**Status:** current
**Updated:** 2026-10-15
**Related:** [Interface decision](../decisions/implemented/2026-10-12-state-space-entry.md)

## Scope

AG and board share one read/write state entry, but remain distinct state spaces.
The entry reuses domain owners, typed views and output preparation. It adds no
state database, `StateView`, copy cache or script executor. AG mutation replaces
current `working_state`, not the whole AG.

## Interface and operations

```text
nmg state <read|write> <ag|board> [operation] [named options]
nmg_state(action="read"|"write", space="ag"|"board", operation?, ...)
```

Read defaults to operation `read`; write requires a space-specific operation.
[Shared state wiring](../../src/integration/state.ts) and
[CLI declarations](../../src/cli/commands.ts) own operation sets and validation.
Unknown space, direction or operation fails; it never redirects to another space.
AG rejects extra board/addressing fields. Hosts must not silently discard those
fields and execute a write.

`SESSION`, `TASK` and `AGENT` are substitutions, not literal identities. AG calls
require an already running compatible resident daemon, as specified below.
Board writes explicitly publish content; do not expose private state or secrets.
These command shapes do not report a production execution.

```text
nmg state write ag enable --session-id SESSION --reason "Maintain current state"
nmg state write ag replace --session-id SESSION --text "Complete current state"
nmg state read ag --session-id SESSION
nmg state write ag disable --session-id SESSION
nmg state write board put --task-id TASK --agent AGENT --content "Coordination entry"
nmg state read board --task-id TASK --agent AGENT
```

AG supports `read/status` and `enable/disable/replace/clear`. Board keeps domain
reads, discovery, publication, subscription, leases, delivery, independent verdicts
and closure; it is not generic object `set`. Omitting board `taskId` selects shared
world channel `default`.

The additive `state` RPC advertises capability `state-spaces`. Results preserve
`action/space/operation`, the domain owner's `result` and, when applicable,
`PreparedInformationOutput`; they do not define another state-view protocol.
An incompatible daemon rejects the capability rather than silently using a
different RPC.

## Distinct state spaces

| Space | Address and scope | State and lifecycle | Mutation owner |
| --- | --- | --- | --- |
| `ag` | Private session/frame; host-bound context | Temporary state constrained by AG capacity and frame/session lifetime | AG runtime |
| `board` | Shared task channel/entry with participant attribution | TTL, leases and collaboration state machines; not shared AG or semantic memory | Board owner |

One entry does not merge scope, storage or authority. Publishing private AG
content requires an explicit board write; reads, enablement and address conversion
do not publish it. Cross-space steps have separate results/failure boundaries:
there is no cross-owner atomic transaction or unconditional replay of non-idempotent
board operations.

[AG mutation](../decisions/implemented/2026-10-08-ag-working-state.md) and
[board governance](../decisions/implemented/2026-09-06-board-governance-addressing.md)
own domain preconditions. State dispatch calls those owners; it cannot bypass
rejections.

## AG writer lifecycle and fencing

`state write ag enable` explicitly obtains a reasoned, TTL-bound session writer
lease, reusing existing activation authority and the AG binding owner, not a second
authorization store. `replace` replaces one complete body; `clear` deliberately
discards it; `disable` or expiry removes permission without deleting final text.

The host supplies session/requester. Arbitrary frame, permission or binding is
not a model parameter. Before first transport the client captures the enabled
lease's session/AG/frame/generation binding and retains it on retry. Raw RPC
callers must provide that captured metadata; stale, foreign or missing binding
fails. Binding fences writes; it does not authenticate. Rejection, secret and
capacity checks preserve old content, without truncating or evicting it into success.

AG CLI calls require an already running compatible resident daemon; a one-shot
CLI cannot simulate private session ownership. DSH state transport likewise needs
the resident owner. Failure neither takes over daemon lifecycle, falls back to a
one-shot CLI nor automatically replays a domain rejection. Rebuild missing AG
from the repository or explicit shared-task evidence, not a display cache.

## Existing views and input boundary

```text
read -> owner-admitted data / existing domain projection -> InformationView -> prepareInformationOutput
write -> domain operation at original owner -> short acknowledgement or prepared result in the same view system
```

[`InformationView`](../../src/core/information-view.ts) retains source identities.
AG/board are write spaces; recalled memory and independent workspaces are display
sources, not additional state spaces or AG authority.
[Shared output](../decisions/implemented/2026-10-07-shared-information-output.md)
owns required labels, character budgets and whole-item omission. Dispatch neither
parses old rendered strings nor invents post-write state bodies. AG read uses its
existing snapshot projection; `status` reads writer metadata, not history search.

Pi's widget and `/nmg state` read the owner's snapshot; `nmg_state` AG writes refresh
the view. `/nmg state on|off` only toggles preview. State is carried once in the
persisted per-user-turn `nmg-context` message, not per inference or by successful-write
deduplication. Stale/foreign snapshots do not overwrite current display.

Output and [state carriage](../decisions/implemented/2026-10-08-ag-working-state-input.md)
own the boundary to actual model input. Display, short acknowledgements and
carriage are not disclosure-ledger commits, factual support, collaboration
acceptance or provider-send receipts. Pi final provider-input confirmation remains
unsupported.

## Unified context information items

State content reuses the same `InformationView` protocol. AG/board are source
domains, not new view types or stores. `purpose` is a presentation role: current
state, task material, reasoning scratch, action guidance or runtime diagnostics.
Source identity and purpose are distinct dimensions; task composition is not a
prerequisite for this protocol.

Pi's `nmg-context` consumes information-item lists, not parsed labels/rendered
lines. A candidate, tool observation, board projection or reminder is selected
individually; a complete `working_state` and coherent workspace checkpoint stay
whole. Recall candidates keep preview labels, retrieval-degradation conditions
and the `activeGraphId` needed for references. Control guidance has no fact
authority. Workspace content keeps its independent source and scratch labels;
it does not pretend to be AG data.

The original owner admits data and owns scope/lifetime. Automatic context uses
only this session/frame. Tool observations and board-read projections automatically
continue only into the next user turn. Historical projections without turn
metadata are not silently promoted to current material; explicit reads may still
show them. Historical board reads do not automatically copy into AG. Ordinary
reads stage only open entries without changing the original result, delivery
bookkeeping or board state machine. The Agent judges semantic relevance and
writes lasting progress/blockers into maintained state; keyword matching does not
infer tasks or error recovery.

Context preparation reuses `prepareInformationOutput`. Purpose groups, bodies,
required labels, separators, root labels and omission notice share one 16,000
UTF-16-code-unit output budget. Complete current state and the owner's bounded
compaction-recovery checkpoint come first, then current diagnostics, task material
and action guidance. Ordinary reasoning items cannot displace an admitted
recovery checkpoint; equal-priority items retain stable order. Oversized items
are omitted whole, not rewritten/truncated; empty groups emit nothing.
Omission notices first reclaim trailing optional items, not complete state,
recovery checkpoints or diagnostics. If protected items fill a small budget,
omission counts still survive as metadata.

Structured `views` are input snapshots; `included` identifies admitted output
sources and `omitted` retains omissions. Ordinary tools keep flat presentation
and original budgets; protocol/source identity does not change. Preparation does
not confirm provider send or commit a disclosure ledger. New selection rules do
not delete existing session history. This output budget is not a complete
multidimensional AG-construction budget.

## Model entry and compatibility

Pi, MCP and DSH register `nmg_state`, not a separate `nmg_board`. Model-facing Lab
schema/execution excludes daily `working_state`; other experimental capabilities
remain. False-like `NMG_ENABLE_COORDINATION` rejects board operations and disables
adapter wake polling, without hiding/disabling AG state. Wake and delivery
bookkeeping stay with the board owner, not another model operation entry.

Legacy `taskBoard` RPC, `nmg board` CLI and Lab working-state RPC/CLI remain for
compatibility/administration. They do not relax domain permissions; normal state
and legacy paths call the same owner instead of duplicating behavior. The entry
is not tied to Pi/codemode and introduces no pipeline, arbitrary code execution
or implicit model call.

## Verification boundary

Contract tests cover space isolation, direction/field rejection, binding/capacity
rejection, existing view sources, short acknowledgements, CLI wiring and model
registration. Isolated Pi/MCP protocol integration and DSH real host-contribution
HTTP tests with simulated Cordis services constrain their respective wiring;
the latter does not prove a production DSH GUI started. Full verification,
deployment and user-visible behavior need their own attribution; document checks
do not replace runtime evidence. Fewer tool names do not prove token savings,
model continuity or natural compliance.
