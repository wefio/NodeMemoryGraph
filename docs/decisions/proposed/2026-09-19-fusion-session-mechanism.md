# The fusion mechanism: one session per run

[中文](2026-09-19-fusion-session-mechanism.zh-CN.md)

**Status:** proposed
**Relates to:** [the pilot and its ceiling](2026-09-18-fusion-and-speculation-pilot.md), [fusion legality and accounting](../implemented/2026-09-18-fusion-legality-and-accounting.md)

## Problem

F4 landed fusion's **policy** half (`PlanDriverSpec.fusion`, `PlanSession`/`PlanRun.sessions`,
`piWorker` refusing a continuation by name) and left the **mechanism** half open: the live worker
creates a session per call, so a fused live arm had nothing to reuse. The pilot proposal reported that
as a blocker, which framed a missing mechanism as a property of the design and left an approved budget
unspent. It is a missing mechanism, and the design says what it must be.

## Proposal

`.pi/extensions/nmg/ooo-execution.ts` creates a `ModelRuntime`, one in-memory session, one tool set and
one prompt per call, then disposes the session. Three facts make reuse possible without new SDK
capability:

- `session.prompt(...)` may be called again on a live session; the session's message list is the shared
  context fusion exists to reuse.
- The tools already read host-owned **mutable** state (`{ artifact: string | null; abort }`,
  `{ report, abort }`, `{ value: number }`), so a tool can hold a *box* and read the current unit's
  values at call time instead of closing over them.
- A tool surface is fixed at session creation, so a chain registers the union of what its units may need
  and each tool refuses by name when the current unit lacks that capability.

So: replace the per-unit values the four tool factories capture with one `UnitState` box, and put the
session/prompt loop in `createPiSessionRunner({ provider, modelId, limits, surface })`, exposing
`runUnit(input): Promise<PiRun>` and `dispose()`. `executePiInput` becomes a runner with exactly one
unit, so there is one code path and no duplicated tool surface. The runner re-points the box per unit,
resets `reads`/`runs`/`turns`/`artifact`/`report`, keeps the session, and reports the **per-unit token
delta** (the session total minus what it was at unit start) beside the session total, because fusion's
claim is that a later unit's delta is smaller than a fresh session's.

Then `piSessionWorker` in `evals/ooo-execution/plan-driver.ts` holds one runner per session id and
reports `metrics.sessionId`, which is what the driver's landed fusion path reads.

Two consequences decided here rather than discovered later:

- The artifact tool's `conclusion` schema is a literal union of the *frozen* admitted kinds, which is
  per unit; a chain registers the surface once, so chains use `Type.String()` and rely on
  `artifactEnvelope` (which already refuses an invented kind) plus `constrainedSampling: prefer`. Tight
  literals stay on the single-unit path.
- Today one `ModelRuntime` signal covers a whole call. A chain needs a per-unit abort
  (`session.abort()` on the unit's timer) and a chain budget, so the runtime is created without a
  per-call timeout and the unit timer owns cancellation.

## Alternatives considered

- **Use the design's own fallback (a new session seeded with the accepted bytes) as the fused arm.**
  Rejected: it saves nothing at startup, which is the cost fusion exists to remove. It stays the
  fallback, and the design already says it is sequential handoff rather than fusion.
- **A separate chain runner with its own copy of the tools.** Rejected: two copies of a security-shaped
  surface (one bounded read, a fixed check, one artifact channel) drift, and the copy is the one nobody
  reviews.
- **Make adoption or fusion mandatory in the driver.** Rejected: the policy half is landed and honest;
  what is missing is execution, not scheduling.

## Acceptance criteria

1. `executePiInput` delegates to the runner and the extension keeps exactly one tool surface; `npm run
   lint` and `npm run check` pass, and every existing live path (the adapters, F3's pilot) still runs
   through it.
2. In a live smoke of two units in one session on `deepseek/deepseek-v4-flash`: both units report the
   same `sessionId`, and the second unit's token delta is below what a fresh session spent on the same
   work - fusion's hypothesis in miniature. Spend stays within ~10-30 k tokens.
3. The paid pilot then runs as recorded in [the proposal](2026-09-18-fusion-and-speculation-pilot.md):
   `{unfused, fused}` for D and, after F5, `{no speculation, speculation on one fact}` for E, three
   repetitions each, reporting latency, extra cost, tokens and quality separately, inside the recorded
   1 000 k ceiling and stopping as soon as a measurement is decisive.
4. A fused arm that cannot reach its checks is recorded as a **mechanism** result ("not ready"), never
   as a cost result.

## Risks

- The extension ships with the product, so a refactor there is the riskiest place to work. Mitigated by
  making the single-unit path the same code (every live run exercises the runner) and by the lint,
  check and smoke gates.
- Loosening the artifact schema on chains gives up sampling-time literals. Mitigated because
  `artifactEnvelope` validates the kind and the host still validates the result; the loosening is
  confined to chains.
- A long chain grows one context, which is both the saving and the risk; compaction stays disabled, and
  the pilot's envelope limits per arm keep a chain bounded.
- Spend can drift if the pilot is not stopped on a decisive measurement. Mitigated by the recorded
  ceiling and by the standing rule that an inconclusive cost result stops the arm rather than buying
  more repetitions.
