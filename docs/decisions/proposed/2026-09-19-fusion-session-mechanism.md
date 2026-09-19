# The fusion mechanism: one session per run

**Status:** proposed
**Relates to:** [the pilot and its ceiling](2026-09-18-fusion-and-speculation-pilot.md), [fusion legality and accounting](../implemented/2026-09-18-fusion-legality-and-accounting.md)

## Why this note exists

F4 landed fusion's **policy** half (`PlanDriverSpec.fusion`, `PlanSession`/`PlanRun.sessions`,
`piWorker` refusing a continuation by name) and left the **mechanism** half open: the live worker
creates a session per call, so a fused live arm had nothing to reuse. That was reported as a blocker,
which was the wrong framing - it is a missing mechanism, and the design says what it must be. This note
is the concrete shape of it, so the next pass builds it instead of re-deriving whether it is possible.

## The mechanism

`executePiInput` (`.pi/extensions/nmg/ooo-execution.ts`) creates a `ModelRuntime`, one in-memory
session, one tool set and one prompt per call, then `dispose()`s the session. Three facts make reuse
possible without new SDK capability:

- `session.prompt(...)` may be called again on a live session - the SDK accepts further turns, and the
  session's message list is the shared context fusion is supposed to reuse.
- The tools already read host-owned **mutable** state (`{ artifact: string | null; abort }`,
  `{ report, abort }`, `{ value: number }`), so a tool can hold a *box* and read the current unit's
  values at call time instead of closing over them.
- A tool surface is fixed at session creation, so the chain's surface must be the union of what its
  units may need, with a tool that refuses by name when the current unit does not have that capability.

So: replace the per-unit values the four tool factories capture with one `UnitState` box, and put the
session/prompt loop in `createPiSessionRunner({ provider, modelId, limits, surface })`, which exposes
`runUnit(input): Promise<PiRun>` and `dispose()`. `executePiInput` then becomes a runner with exactly
one unit - one code path, no duplicated tool surface. The runner re-points the box per unit, resets
`reads`/`runs`/`turns`/`artifact`/`report`, keeps the session (and its context), and reports the
**per-unit token delta** (the session's total minus what it was at unit start) alongside the session
total, because fusion's whole claim is that the later unit's delta is smaller than a fresh session's.

Two consequences to state rather than discover:

- The artifact tool's `conclusion` schema is a `Type.Union` of the *frozen* admitted kinds, which is
  per unit. In a chain the surface is created once, so a chain registers `Type.String()` and relies on
  `artifactEnvelope` - which already refuses an invented kind - plus `constrainedSampling: prefer`.
  Tight literals stay on the single-unit path.
- Timeouts: `ModelRuntime.create` is given one signal per call today. A chain needs a per-unit abort
  (`session.abort()` on the unit's timer) and a chain-level budget the driver already enforces, so the
  runtime is created without a per-call timeout and the unit timer owns cancellation.

## What it costs

- **M1, offline:** the extension refactor above plus `piSessionWorker` in
  `evals/ooo-execution/plan-driver.ts` that holds one runner per session id and reports
  `metrics.sessionId`. Touches a shipping extension, so the gate is `npm run lint`, `npm run check` and
  the existing live adapters, plus the driver's canned fusion cases (already landed).
- **M2, cheap live smoke (~10-30 k tokens):** two units in one session on `deepseek/deepseek-v4-flash`;
  the assertion is the fusion hypothesis in miniature - one `sessionId` for both units, and the second
  unit's token delta below what a fresh session spent on the same work.
- **M3, the paid pilot (~400 k of the 1 000 k ceiling):** the D arms `{unfused, fused}` and, after F5,
  the E arms `{no speculation, speculation on one fact}`, three repetitions each, reporting latency,
  extra cost, tokens and quality separately. Refusals stay as recorded: a fused arm that cannot reach
  its checks is a **mechanism** result ("not ready"), not a cost result.

## Alternatives

- **The design's own fallback (a new session seeded with the accepted bytes).** Still available and
  still *not* fusion - it saves nothing at startup, which is the cost fusion exists to remove. Kept as
  the fallback, not as the arm.
- **Two tool surfaces (a chain runner with its own copy).** Rejected: two copies of a security-shaped
  surface (bounded read, fixed check, one artifact channel) drift, and the copy would be the one nobody
  reviews.
- **Making adoption or fusion mandatory in the driver.** Rejected: the driver's policy half is landed
  and honest, and the missing piece is execution, not scheduling.
