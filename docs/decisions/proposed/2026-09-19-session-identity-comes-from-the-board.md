# A unit's session comes from the board

[中文](2026-09-19-session-identity-comes-from-the-board.zh-CN.md)

**Status:** proposed
**Relates to:** [The fusion session mechanism](../implemented/2026-09-19-fusion-session-mechanism.md)

## Problem

The fusion mechanism is landed and tested - one `createPiSessionRunner` per run behind a
`UnitState` box, the extension down to a single tool surface, per-unit token deltas beside the
session total - but nothing in the product decides to reuse a session. The only caller today is
the live arm's `piSessionWorker`, and it keys its runners off the spec's own `session.id`, which
is an eval artifact. A second caller must not invent a parallel notion of "session", and it must
not add a tool: the product's agent-facing surface is already the board.

## Proposal

Session identity for a unit is read from, and written to, the board. No new tool, no new store
column.

- **Resolution is a read, not a module.** The identity already exists, in three places that
  nothing has to derive: the caller that holds the unit already knows its own session
  (`ctx.sessionManager.getSessionId()` in the extension), the entry it wrote carries
  `source_session_id`, and a managed write is already fenced to a registered run
  (`coordinateRunWrite`). So "this unit continues the previous unit's session" is simply *the same
  session*, read from facts the board and the caller already hold - not a grouping to declare and
  not a helper to maintain. The eval arm states the same thing its own way - `sessions: [[...]]` in
  the spec and an id derived as `session:${first}` - and that stays in the spec, where a
  measurement artifact belongs.
- **Use.** A runner is held per board session, not per spec field: when the host or driver runs
  another unit of the same board session, it reuses that session's runner, which is what makes the
  later unit's token delta the quantity fusion is claimed to reduce.
- **Recording.** The move - admit the next unit, or close the session naming the condition that
  closed it - is written to the board, which is exactly the obligation the fusion design already
  states: a move decided online must be recorded with the facts it used, or "baseline" is
  unfalsifiable.
- Legality is unchanged: `sharedSessionLegal` stays the only rule, the move stays repair-first and
  deterministic, and there is no bound and no switch.

## Alternatives considered

- **A new `nmg_unit` tool.** Rejected: a fused session would then be declared twice - once by the
  tool call and once by the board - and two homes for one fact is how they drift. It would also
  make every host register the tool to take part.
- **Key the product session off the plan or spec file.** Rejected: a spec is the measurement
  artifact; product work arrives as board entries, so the identity would be borrowed from a file
  the product does not have.
- **A store column for "session continues session".** Rejected: it is derivable from the entries
  that already exist, and a stored derivation can go stale while the derivation itself cannot.

## Consequences

No resolution step is added: the session identity is the caller's own, which is also the one the
wake loop, the delivery receipts and the managed-write fence already use, so a unit cannot end up in
a session the board does not know about.

The extension's live path can then run a second unit of one board session without a fresh session
startup, and the per-unit verdict, the session id and the token delta are read from the runner
that produced them rather than reconstructed.

The field trial follows from this shape: two real units in one board session, per-unit verdicts,
the recorded move, and wall clock, tokens and cache reads beside the same work done in two fresh
sessions - measured through the product path rather than through the eval driver alone.

## Acceptance criteria

1. A second unit of one board session resolves to the session id the board already records for the
   first unit, with no new tool registered and no new store column.
2. The move - admit, or close naming the condition - is written to the board, and reading the board
   back returns it with the facts it used.
3. A test pins both ends: resolution returns the board's session id for a unit whose entry carries
   it, and a unit run after another in one board session reports that same session id from the
   runner that produced it.
4. The field trial measures two real units in one board session against the same work in two fresh
   sessions, reporting per-unit verdict, session id, tokens, cache reads and wall clock.

## Risks

- The board's session id is also the wake loop's identity. A host that reuses one session for
  unrelated work would record a chain that is not a plan chain; the move is written per unit, so
  such a chain is readable and attributable rather than invisible.
- Reusing a session keeps the union tool surface, whose first unit costs about 0.7 k extra tokens
  (measured), so fusion can spend more fresh input than it saves on a very short chain; the cap
  experiment already located the knee at two units per session.
- A unit with no board entry has no session to continue, so it cannot be fused and falls back to a
  fresh session. That is the honest default, not a degraded mode.
