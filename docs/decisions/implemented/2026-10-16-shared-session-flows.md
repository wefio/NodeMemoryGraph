# Shared Session Flows in the Integration Layer

[中文](2026-10-16-shared-session-flows.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [harness adapters as thin transports](../../../skills/nmg-memory/references/harness-adapters.md)

## Problem

The recall guard, the bounded session task window, tool-result observation,
answer-overlap attribution, agent identity, and the board wake loop all lived
inside the pi adapter (`.pi/extensions/nmg/index.ts`). The harness-adapter
boundary says every capability must live in `src/*` or the daemon so a second
adapter can forward the same RPC instead of forking the logic, but these four
flows were pi-only code. Adding the OpenCode adapter under that rule would have
meant either copying the logic or silently dropping the behaviors —
both defects by the repo's own definition.

## Decision

Move the flow logic into six host-neutral modules under `src/integration/`,
with behavior preserved byte-for-byte and adapters reduced to binding their
host-shaped transport and emission primitives:

- `session-recall-flow.ts` — the per-turn tool-flow guard (`SessionRecallFlow`).
- `session-task-window.ts` — bounded task anchors across terse continuations
  (`SessionTaskWindow`, `SessionRecallRequest`, task-prompt classification).
- `tool-observation.ts` — message flattening, excerpting, successful-commit
  detection, memorable-result filtering, and trace summarization.
- `agent-attribution.ts` — the diagnostic attribution cache plus answer/prompt
  text extraction (`AgentAttributionFlow`, `extractAnswerText`,
  `extractPromptText`).
- `agent-identity.ts` — stable per-agent identity load-or-create and rename;
  the fallback anchor namespace is a parameter (`hostPrefix`), pi passes `"pi"`.
- `board-wake.ts` — wake config/state persistence under a caller-provided data
  directory, the daily budget gate, the pure wake-candidate predicate,
  candidate collection, delivery filtering, world-channel broadcasting, and
  delivery, with `invoke` and `sendWake` injected.

Supporting types moved with them: `TaskBoardToolEntry`/`TaskBoardToolResult`
into `tool-contract.ts`, and the five `NMG_AUTO_RECALL_*` environment readers
into `config.ts` (all parameterized by `environment`, defaulting to
`process.env`). `piUserTurnKey`/`projectPiBranch`/evidence-source selection,
the TUI, the Shadow bridge, and prompt composition stay pi-side: they are pi's
surface, not shared loop state. Their tests moved to
`tests/integration/session-flows.test.ts`; pi-adapter tests keep only behavior
pi itself wires.

## Alternatives considered

- Keep the flows in pi and copy them into the OpenCode adapter. Rejected:
  duplicated policy drifts and goes stale — the exact defect the adapter-boundary
  rule names.
- Push the flows into the daemon RPC surface. Rejected for now: the recycle
  windows are per-session in-process state with sub-second budgets; putting
  them behind an RPC would add a round trip and a daemon restart boundary for
  state that is intentionally cheap and idle-side.
- Parameterize nothing and re-export the move as a shim from pi's index.
  Rejected: keeps pi the apparent owner and hides the real module graph from
  other adapters.

## Consequences

- Every harness adapter must import these functions rather than reimplement:
  a wake loop that skips `collectWakeCandidates` loses directed-inbox
  semantics, silently, so the capability matrix (see
  `docs/design/harness-capability-matrix.md`) tracks function-level alignment.
- Adapters gained the two injected seams (`invoke`, `sendWake`) and a `dataDir`
  parameter; pi's behavior is unchanged (50/50 tests pass on the moved suites).
- `loadOrCreateAgentIdentity` fallback anchors are now namespaced by
  `hostPrefix`, so a future second adapter sharing a session id never routes
  through pi's identity row.
- Energy cost is one indirection per call; complexity of each module is
  unchanged from its pi source.

## Rebase reconciliation (2026-10-17)

Landing rebased onto the daemon pipeline (#90); the merge outcomes:

- The proposal protocol (`searchCueParams`, the `recallSource` observation
  guard, and the recall-gate lab flow) stays on the timing line and does not
  move with this PR; the former pi piggyback test was removed with it. The
  no-raw-prompt constraint on `beginDisclosureTurn` remains covered by core
  (`tests/core/session-active-graph.test.ts`) and service
  (`tests/cli/service.test.ts`) tests.
- The Chinese `session-flows` cases now use prompts the daemon pipeline's gate
  (`EXPLICIT_RECALL_PATTERNS`) recognizes; the timing line's extra gate
  calibration ("来着" question forms, `[你您]记得…` question forms) is not part
  of this PR.
- Environment note: daemons spawned by the pi adapter run the built
  `dist/cli/main.js`, not the sources. In a fresh worktree, recall tests run
  before `npm run build` fail with "No matching NMG memory found."-style
  diagnostics.
