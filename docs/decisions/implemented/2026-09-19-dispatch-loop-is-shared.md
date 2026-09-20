# The dispatch loop is shared; the arms keep their declarations and their measurement

[中文](2026-09-19-dispatch-loop-is-shared.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Supersedes:** [The arms get their own driver](2026-09-17-arms-get-their-own-driver.md)
**Relates to:** [When the chain path may be entered](2026-09-19-when-the-chain-path-may-be-entered.md), [A unit's session comes from the board](2026-09-19-session-identity-comes-from-the-board.md)

## Problem

The arms' driver already runs a plan to completion against the product's own admission gate: it takes the
legal set from `BoardAdmission.candidates()`, claims a ticket, freezes the task, runs a worker, puts the
result on the board channel, lets the store decide the verdict, and moves on - with session reuse as the
one variable the fusion arms vary. That loop is the thing the product needs in order to dispatch a run at
all, and today the product cannot reach it: the product governs runs (register, freeze, bind, adopt,
cancel, status) and offers the worker's tools, but nothing in it decides what to run next and runs it.

[The 2026-09-17 decision](2026-09-17-arms-get-their-own-driver.md) put that loop in `evals/` on purpose,
and its reason was measured rather than stylistic: the round driver it replaced was 1 063 lines carrying 42
references to three fixed task names, so "make the plan an option" was a rewrite, not a parameter - and the
design's ordering said "先做语义判定，**不先搭建通用调度平台**". Both halves of that argument are about
_generalising a specific experiment_. The loop that exists now is not that experiment: it depends on
`BoardAdmission` and on a worker port, and on nothing else. Copying it into the product would create the
second implementation the same decision warned against, and importing it from `evals/` would make the
product depend on a research instrument.

## Decision

**The loop that dispatches a plan moves to the shared layer, and the arms' driver becomes a caller of it.**

- **One loop.** `dispatchPlan` (or the name it lands under) lives with the other shared execution
  decisions, takes the plan and each task's spec as the caller has them, and owns: the candidate set, the
  claim, the freeze, the worker call, the result entry, the verdict, the failure and refusal accounting,
  and the session decision at each boundary (`openUnitSession`), recorded as a run fact.
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
- **Do nothing; keep the loop research-side and leave the product unable to dispatch.** Rejected: the
  permission rule decided the same day ("the chain path may be entered when the semantics allow it, a
  continuable task exists and the host supports session reuse") has no caller in the product without a
  loop, so the rule would stay advice.
- **Generalise the retired round instead.** Rejected: that decision is what measured the 42 couplings, and
  the round instrument has been retired since 2026-09-18.

## Consequences

- **The measurements stay comparable.** The driver's report format and its CLI do not change; the loop it
  calls is the same code, so a cell recorded before and after this move is the same cell. The archive's
  `matrix.json` and the plan's grade rule keep working unchanged.
- **A move, not a rewrite.** The loop's dependencies (`BoardAdmission`, the freeze, the store's verdict, a
  worker port, `openUnitSession`) are all shared and already imported by the driver; nothing in the move
  adds a product policy or a new store column.
- **The product still needs a caller.** With the loop shared, a product path can dispatch a run - but no
  such caller exists yet, and writing one is a decision about which surface dispatches (a command, the
  daemon, or the host's own loop calling the shared function). This record makes the loop reachable; it
  does not claim the product dispatches.
- **The arms' identity survives.** Their driver keeps the spec format, the live/stub worker choice, the
  report, and the archive; a reviewer can still read "what the arms ran" without reading the product.

## Deferred

- **The product-side caller** (which surface dispatches a run, and what worker port it supplies).
- **Where a per-unit session `capability`/`authority` is declared** when a host has more than one. Today
  the arms declare one capability and one authority for the whole run, and the read-scope half of legality
  (`visible`) comes from the task spec - so the condition is live for the half that can widen a read, and
  vacuous for the half a single-capability host cannot vary.
- **The default bound.** Unchanged: one unit per session unless the caller declares otherwise.
