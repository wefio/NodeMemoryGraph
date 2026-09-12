# What the wait is actually worth (restricted OoO)

**Related:** [design](../../design/ooo-execution-bootstrap.md) ·
[admission run](../ooo-admission-2026-09-08.md) ·
[speculation decision](../../decisions/proposed/2026-09-11-ooo-speculation.md)

Measured 2026-09-12. Zero model tokens: no provider was contacted for any number below.

## Question

The design's premise is that out-of-order execution buys wall clock by covering an external wait
with work that had to happen anyway. It also fixes the evidence for that claim: _"后台操作与 B 的
时间重叠才是等待被利用的证据"_. This run asked two things at once — does the premise hold as the
check gets longer, and does the number the round reports measure the quantity the design defines?

## Method

`.nmg/probe-check-duration.ts` drives the real `runCycle` through `compareModes`, so the
orchestrator, the board, the candidate worktrees, the check processes and the acceptance rules are
the production ones. Two dimensions are chosen rather than observed:

- the round check does real CPU work of a chosen duration τ in a real child process;
- task B additionally does real CPU work of a chosen duration β before returning its accepted answer.

The probe itself is a local, uncommitted one-off (`.nmg/probe-check-duration.ts`): it states its sweep and the record below states the grid, so it can be rebuilt, while the metric change it verified is in `cycle.ts` with tests. A replay returns instantly, so an offline arm cannot be overlapped at all; CPU-bound workers are a
**lower bound** for the real case, because two CPU-bound activities contend for cores while a model
call mostly waits on the network. The answers are the ones the comparison test already uses, and the
sweep asserts quality parity at every point (verdicts are identical across the whole grid).

Below, "harness hidden" is `measurements.hiddenWaitMs` as reported by the round; "task-covered" is
the same overlap computed independently from the round log.

## Observed

Corrected definition (task's own claim-to-return window ∩ check window):

| check τ | worker β | ooo wall | sequential wall | ooo − seq | harness hidden | task-covered |
| ------: | -------: | -------: | --------------: | --------: | -------------: | -----------: |
|      0s |       0s |   3.19 s |          3.96 s |   −0.77 s |       **0 ms** |         0 ms |
|      0s |       2s |   5.08 s |          5.98 s |   −0.90 s |         838 ms |       2.06 s |
|      0s |       8s |  11.07 s |         11.80 s |   −0.73 s |         835 ms |       8.06 s |
|      2s |       2s |  12.98 s |         15.61 s |   −2.63 s |       2 059 ms |       2.06 s |
|      2s |       8s |  18.98 s |         21.57 s |   −2.59 s |       2 715 ms |       8.05 s |
|      8s |       2s |  36.95 s |         45.48 s |   −8.53 s |       2 049 ms |       2.05 s |
|      8s |       8s |  42.82 s |         51.54 s |   −8.73 s |       8 050 ms |       8.05 s |
|     40s |       2s | 165.04 s |        205.71 s |  −40.67 s |       2 053 ms |       2.05 s |
|     40s |       8s | 171.12 s |        212.11 s |  −40.99 s |       8 050 ms |       8.05 s |

For contrast, the earlier run of the same grid with the previous definition reported 713 ms at
(0s, 0s) and 40 647 ms at (40s, 2s).

Soundness check on all nine points: A's artifact timestamp is strictly after the check's terminal
event, so the saving is not obtained by breaking the ordering rule.

## What the numbers say

1. **Task-covered wait is `min(τ, β)`.** It never exceeds the task's own work, whatever the check
   does — the "longer wait, more hidden" reading is refuted. The share of the round peaks when the
   check and the independent task are comparable (8 s / 8 s ⇒ 15.6 % of the control's wall) and
   falls off on both sides.
2. **The wall-clock saving is a different quantity.** For τ ≫ β the round is almost a full τ faster
   (−40.7 s of −205.7 s), while the task's own work covered only 2.05 s of it. Reading the round log
   shows why: the check overlaps the **host's verification of B** (the mutation matrix and the
   candidate check, whose windows each contain a τ-long run). That is real, it is the class-A
   host-side overlap the design admits, and it shortens the round — but it is host work overlapping
   a host check, not the external wait being covered by independent work. Under the design's own
   evidence rule, only the second counts as wait utilisation.
3. **The bound observed is `1/k`.** The round spends roughly `k·τ` in serial verification passes
   (k = 4 here: the round check plus one candidate check per task). The task-covered wait is one τ
   at most, so its share of the round cannot exceed about `1/k` ≈ 25 %, and the operating point
   τ = 1.9 s against β = 54.8 s (round 7: 134.9 s) lands at 1.4–3 %, consistent with the 1.6 s the
   design already recorded for an earlier round.

## The report's own defect

`hiddenWaitMs` was computed as the task's _claim-to-submission_ window, and submission happens after
the host has verified the candidate. Because the verification window outlasts the check, the metric
reported essentially the whole check as hidden even when the task's own work lasted a fraction of
it — the (0s, 0s) point is the proof: 713 ms of "hidden wait" with nothing to hide behind. It is now
the claim-to-return window (`evals/ooo-execution/cycle.ts`), with two regression tests in
`cycle.test.ts`: the invariant that nothing independent means nothing reported (0 ms at (0s, 0s)),
and a discriminating case (1.5 s check, 0.2 s task) that reports 2 053 ms instead of 1 539 ms under
the old definition — reverting the metric fails that test. Historical figures quoted elsewhere
(40.6 % of a round, 54.8 s hidden) carry the old semantics and should be read as "the check's window
that overlapped the task's attempt", not as wait covered by the task's work. My own independent
column in the probe reproduced the same mistake before the fix, which is why the two columns agree
only from (2s, 2s) onwards.

## Not measured

- No model ever ran in this sweep: β is real CPU work, so network-bound model time is approximated
  from below.
- One repetition per grid point; no distribution, no held-out workload.
- The check is a controlled CPU load, not a real integration check; the real in-round check is
  ~1.9 s, which is what the operating-point figure uses.
