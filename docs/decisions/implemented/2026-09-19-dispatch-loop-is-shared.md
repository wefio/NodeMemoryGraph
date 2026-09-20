# The dispatch loop is shared; the arms keep their declarations and their measurement

[中文](2026-09-19-dispatch-loop-is-shared.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Supersedes:** [The arms get their own driver](2026-09-17-arms-get-their-own-driver.md)
**Relates to:** [When the chain path may be entered](2026-09-19-when-the-chain-path-may-be-entered.md), [A unit's session comes from the board](2026-09-19-session-identity-comes-from-the-board.md)

## Problem

The arms' driver runs a plan to completion against the research instrument's admission gate: it takes the
legal set from `BoardAdmission.candidates()`, claims a ticket, freezes the task, runs a worker, puts the
result on the board channel, lets the store decide the verdict, and moves on - with session reuse as the
one variable the fusion arms vary. The product already has an Agent-driven path: the board wakes an
existing host session, and the Agent claims, works and delivers through `nmg_board`, with an independent
judge for acceptance. The extracted loop is a programmatic caller of board operations; absence of a
product caller for this function does not mean that the product cannot execute blackboard tasks.

[The 2026-09-17 decision](2026-09-17-arms-get-their-own-driver.md) put that loop in `evals/` on purpose,
and its reason was measured rather than stylistic: the round driver it replaced was 1 063 lines carrying 42
references to three fixed task names, so "make the plan an option" was a rewrite, not a parameter - and the
design's ordering said "先做语义判定，**不先搭建通用调度平台**". Both halves of that argument are about
_generalising a specific experiment_. The loop that exists now is not that experiment: it depends on
board operations and a worker port. The extracted `DispatchBoard` port leaves `BoardAdmission` as the
research implementation, rather than requiring the product to open its `ooo_probe_*` store. Copying the
loop would create the second implementation the same decision warned against, and importing it from
`evals/` would make the product depend on a research instrument.

## Decision

**The loop that dispatches a plan moves to the shared layer, and the arms' driver becomes a caller of it.**

- **One programmatic loop.** `dispatchPlan` lives with the other shared execution
  decisions, takes a board and worker port, and consumes the board's candidate set. It owns the ordering of
  the claim, the freeze, the worker call, the result entry, the verdict, the failure and refusal
  accounting, and the session decision at each boundary (`decideSessionMove`), recorded as a run fact when
  a run-fact port is supplied.
- **The worker is a port.** What the loop calls to produce a candidate is supplied by its caller - the
  arms supply a live model worker or a recorded one, the host supplies the runner it already has. The
  port's shape is the one the arms already use; the adapter implements it, and no policy moves into it.
- **The arms keep what makes them research.** Their spec files, their cells' declarations (bounds, slots,
  per-unit session declarations), their report format and their archive stay where they are. The arms get
  their own _declarations and measurements_; they no longer get their own _loop_.
- **The 2026-09-17 decision stands except for this clause.** Its rule that a _planning_ platform is
  postponed - a generic scheduler that decides plans, ranks them, or holds a queue - is unchanged and is
  not what this moves. What changes is only where the loop that executes a given plan lives.

## Alternatives considered

- **The product imports the driver from `evals/`.** Rejected: it makes the product depend on a research
  instrument, and the instrument's own reports would then be produced by the code under test.
- **A second loop, product-side.** Rejected: two loops answering "what runs next" drift, and the one the
  measurements were taken on would stop being the one the product runs - which is exactly why the arms
  were extracted in the first place, read from the other direction.
- **Keep the programmatic loop research-side.** Rejected: a host that needs this execution pattern would
  have to import `evals/` or duplicate it. The existing Agent-driven blackboard path remains a product
  execution path and does not need a new tool or command to exist.
- **Generalise the retired round instead.** Rejected: that decision is what measured the 42 couplings, and
  the round instrument has been retired since 2026-09-18.

## Consequences

- **The measurements stay comparable.** The driver's report format and its CLI do not change; the loop it
  calls is the same code, so a cell recorded before and after this move is the same cell. The archive's
  `matrix.json` and the plan's grade rule keep working unchanged.
- **The board is a port.** The loop consumes `DispatchBoard`, the freeze, a
  worker port and the shared session decision; nothing in the move
  adds a product policy or a new store column.
- **Extraction is not product activation.** The fast dispatch tests exercise a fake board, with a real
  Store for session-fact recording. They do not demonstrate the existing `nmg_board` host path invoking
  this loop. Product integration reuses the existing blackboard and host flow; it does not introduce a
  tool, command or separate OoO entry. The [integration audit](../../design/task-unit-semantics-obligations.md#product-call-path-audit-2026-09-20)
  separates existing rules, existing lifecycle operations and the observed call-site boundary.
- **The arms' identity survives.** Their driver keeps the spec format, the live/stub worker choice, the
  report, and the archive; a reviewer can still read "what the arms ran" without reading the product.

## Deferred

- **Connection to the existing product blackboard flow.** This is integration work, not a pending choice
  of a new entry point. Reuse the existing legality and session rules rather than implementing a second set.
- **Where a per-unit session `capability`/`authority` is declared** when a host has more than one. Today
  the arms declare one capability and one authority for the whole run, and the read-scope half of legality
  (`visible`) comes from the task spec - so the condition is live for the half that can widen a read, and
  vacuous for the half a single-capability host cannot vary.
- **The default bound.** Unchanged: one unit per session unless the caller declares otherwise.
