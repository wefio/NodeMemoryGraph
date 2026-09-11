# Gate speculation on measured payoff, and do not speculate to hide a wait

[中文](2026-09-11-ooo-speculation.zh-CN.md)

**Status:** proposed
**Relates to:** [Bootstrap restricted OoO through real development](2026-09-09-ooo-bootstrap.md)

## Problem

The bootstrap design forbids speculation and preemption outright, on the grounds
that only a real external wait justifies passing the queue head. That rule is
safe but blunt: it also forbids the class of speculation whose wrong guess costs
nothing, and it gives no way to tell a paying speculation from a losing one.

CPU out-of-order execution makes speculation pay for a specific reason: a wrong
guess wastes resources that were already committed or free, while a right guess
hides a stall. Two questions follow, and they have different answers here. Does
this system have points where a wrong guess is free? And is hiding a long wait by
guessing its outcome a real opportunity?

## Proposal

Adopt the free class, refuse the wait-hiding class, and keep the mechanism that
makes a guess explicit and reversible.

**Adopted: host-side speculation whose wrong guess costs no tokens.** Pre-build
the candidate worktree the next step needs, pre-run checks that both branches
require, pre-compute the mutation matrix, and pre-compose a dependent task's
frozen envelope under both assumptions. Nothing is committed, results are
discardable, and the payoff is non-negative.

**Adopted: assumption-bound envelopes.** Every admitted speculation states its
assumption in the frozen instruction (`assumed outcome (unverified)`), so the
input digest binds it and a contradicting terminal event fences the artifact
instead of accepting it. This mechanism is required independently by the
downstream-pushback edge, where a dependent task's rejection reissues the
upstream task and fences whatever bound to the old digest.

**Refused: token-costing speculation of an event outcome.** The premise does not
hold in this system. Measured from the repository's own reconcile receipts
(`.rcp/receipts/`, 23 timed runs), the largest normal external wait is the whole
verification run: median 80.7 s, minimum 15.9 s, maximum 134.5 s. A wait of
twenty minutes is nine times the maximum ever observed, which is evidence of a
hung program rather than a workload worth hiding; waits this system produces are
ordinary, and ordinary waits are filled with required work instead. At the
largest normal wait the break-even hit rate would be 0.25, but the only
high-probability premise available is "the frozen check passes", which is nearly
deterministic — and a nearly deterministic premise means the dependency should be
removed rather than speculated around. Any wait long enough to make guessing pay
is therefore either abnormal or should be decoupled into an asynchronous job
whose result is collected later, not hidden by a guess.

**Forbidden**: value speculation (guessing another task's artifact content, whose
accuracy is far below guessing an event outcome and whose mispredictions poison a
whole dependency chain), guessing which tasks exist, and preemption.

## Alternatives considered

- **Keep the blanket ban.** Safest, and it is what this proposal keeps for waits;
  it only gives up the free class, which is why the proposal does not keep it
  wholesale.
- **Speculate to hide every wait.** Pays for guesses whose break-even is
  negative and hides waits that required work already fills.
- **Decouple long external work instead of hiding it.** Chosen for long waits: a
  job submitted and collected later removes the wait from the critical path
  instead of guessing its outcome. This is the alternative that made the
  wait-hiding class unnecessary.
- **Speculate the plan (let a model choose the next tasks).** Removes the fixed
  plan that makes acceptance meaningful and puts the guesser in the authority
  seat.
- **Let a second model decide whether a guess fits.** A second-hand judgement
  cannot replace evidence: judges flip a measurable share of their own pairwise
  preferences, and a reference-free judge scores plausibility rather than
  correctness, which is the false-positive basin this project already measured in
  an earlier round. An advisor may say no; only the host may say yes.

## Acceptance criteria

- Each round records worker tokens, per-step wall time, and any squashed
  speculation with its cost; without these numbers no payoff claim is checkable.
- Host-side speculation is measured for net time saved and must not lengthen the
  critical path when the guess is wrong.
- A mispredicted artifact is never accepted: a test proves that a contradicting
  terminal event reverts the affected task to a fresh attempt and fences the
  dependents bound to the assumed digest.
- A round that ends with squashed speculation reports the loss explicitly.
- A wait that exceeds the largest observed verification run is treated as a
  possible hang and reported as such, not exploited as speculation headroom.

## Risks

The free class is cheap but small, and its benefit may not be measurable; the
assumption machinery costs a new state dimension in a round whose recovery work
is not finished. Recording waits also creates pressure to treat a long wait as an
opportunity, which this record explicitly rejects. Finally, a high hit rate on a
guessed precondition is a signal that the dependency should be removed rather
than speculated around, and the measurement requirement must not become a reason
to keep a dependency whose wait carries no information.
