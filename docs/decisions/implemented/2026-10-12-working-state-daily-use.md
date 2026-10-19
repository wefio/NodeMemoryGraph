# Maintained working state for daily use

**Status:** implemented
**Approved:** explicit
**Relates to:** [State writer](2026-10-08-ag-working-state.md), [Turn carriage](2026-10-08-ag-working-state-input.md)

[中文](2026-10-12-working-state-daily-use.zh-CN.md) · [Terms used](2026-10-12-working-state-daily-use.terms.yaml)

## Problem

A working-state writer and a carriage path do not by themselves make current
progress easy to inspect or establish when an Agent updates it. Rediscovering
progress through history or semantic retrieval defeats the maintained-state
purpose. The user prioritizes a usable state loop before other AG improvements.

## Decision

The shared Agent policy instructs ongoing multi-step work to maintain a compact
current-status anchor through the existing opt-in `working_state` lease. It names
goal, verified completion/source, current step, next action and blockers, and
updates complete text only on meaningful changes. Planned, implemented and
verified work remain distinct. The policy is instruction-driven, not an automatic
progress classifier or a forced model continuation. Its canonical model-facing
text remains `src/prompts/nmg-prompts.yaml`; the operating Skill routes to usage.

Pi shows a read-only preview near the editor from the same admitted snapshot its
turn message carries. Six source lines are shown, with
an explicit `/nmg state` full-view hint when more exist. The sub-command sends the
complete admitted text through the host's notification UI, including RPC clients;
non-terminal modes do not receive terminal widgets. `/nmg state on|off` toggles
only the preview: it changes no state, no carriage and no ledger entry. Both
state actions also appear as entries of the `/nmg` interactive menu, next to the
recall and wake entries, so the extension adds no top-level command. It does not send model messages,
append session entries, grant a writer lease, search memory or commit a ledger.

Startup/reload and working-state tool results refresh the view while the preview is on. There is no idle
polling and no snapshot read per model call. A local request generation fences
delayed presentation across newer reads, session starts and shutdown. Foreign or
incompletely prepared snapshots and owner failures cannot present old progress as
current, and contribute no state body to the turn. Empty/cleared state removes
the widget. UI presentation does not establish final provider input visibility.

Completed status stays readable after writer disablement. Frame/session eviction,
release and daemon restart can remove it. Necessary progress facts remain in
repository or explicit shared task references; a missing state is rebuilt from
current evidence, not a display cache or a guessed continuation. The session-frame
fallback does not acquire semantic task identity or A→B→A restoration.

## Consequences

The core writer, storage, authority, public RPC and model tools remain unchanged.
Pi owns only native display and lifecycle mapping. Other hosts can read the same
snapshot/preparation contract; the shared update policy is not Pi-specific.

Safety/contract tests cover fresh status, direct complete reads, clear, session
isolation, owner failures, foreign snapshots, delayed responses and shutdown,
explicit preview clipping, RPC/terminal separation and protected model history.
The loaded Pi factory with a real isolated HTTP daemon verifies snapshot-to-widget
and full-command notification alongside per-turn carriage, writer
disablement with readable final state, and clear.
These checks are scoped mechanics, not proof of natural model adherence, terminal
visual quality, token savings or final provider confirmation.

## Alternatives considered

- Another task/state database or persistent display cache: rejected; the existing
  private AG holds the one provisional value, with authoritative facts elsewhere.
- Inferring progress or completion from every tool result: rejected; the Agent
  maintains public evidence-backed status rather than an adapter guessing facts.
- Forcing another model call to update state: rejected; no new continuation loop.
- Searching semantic history on each status read: rejected; snapshot reads address
  the current value directly.
- Persisting every status display into model/session history: rejected; user
  presentation is not another input source or a final disclosure receipt.
