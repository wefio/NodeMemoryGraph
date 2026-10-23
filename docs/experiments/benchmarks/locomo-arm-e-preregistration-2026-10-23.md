# LoCoMo arm E preregistration: multipath pool plus session adjacency

[简体中文](locomo-arm-e-preregistration-2026-10-23.zh-CN.md) · [Terms](locomo-arm-e-preregistration-2026-10-23.terms.yaml)

**Status:** assigned, not run
**Owner:** the neighbour-probe author; read-only review by the contract owner
**Relates to:** [LoCoMo local audit](locomo-local-audit-2026-10-23.md)

## Why this exists

Two arms were measured on the same frozen eligible projection and are not
comparable as substitutes:

| arm | multi-hop all@20 | paired versus original query | exact two-sided p |
| --- | ---: | --- | ---: |
| A original query top-20 | 16.1% | — | — |
| D100max multipath, pools @100, fused to 20 | 20.8% | 16W/3L | 0.0044 |
| C2 session adjacency ±2 | 19.4% | 16W/7L | 0.0931 |
| C2 at equal character budget | 17.9% | 12W/7L | 0.3593 |

Adjacency alone does not replace fusion, and fusion alone leaves the adjacent
turn of a retrieved utterance out of the page. They act on different losses, so
the only remaining combination worth a measurement is fusion followed by
adjacency. This document fixes the protocol before the result exists, so the
decision cannot be made after seeing the numbers.

## Inputs (read-only; do not modify)

- `raw.D100max` from
  `evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/raw-candidates.jsonl`
  (20 ranked records per eligible question, with id, content, score, event_time,
  stored_at, raw_content).
- `A.contextCharacters` for the same questions from `rows.jsonl` in that run.
- The neighbour probe's pure functions (`selectAnchors`, `expandNeighbors`,
  `fuseNeighborArm`) and `sliceByCharBudget` from the frozen contract.
- `evals/locomo/results/locomo-eligible-manifest.json`
  (sha256 `194ac55a594e…e68d`; multi-hop 279, regression 145).

## Fixed protocol

1. Control arms first. Recompute A and D100max through the new pipeline and
   reproduce the published figures (A: 16.1 / 73.1 / 38.4; D100max:
   20.8 / 75.6 / 41.7 with 16W/3L), then reproduce C2 (19.4 / 75.3 / 42.2 with
   16W/7L). If any control arm does not reproduce, stop and report a blocker
   instead of continuing: a mismatch means pipeline drift, and a combination
   built on drifted arms is not evidence.
2. Combination. Take the ordered D100max list as the baseline, resolve the first
   `anchorCount = 5` records back to their source turns by content match
   (duplicate text resolves to the first turn; count ambiguities and unresolved
   anchors separately), expand ±2 turns within the same session, and fuse with
   the existing rule (`keepBaseline = 10`, round-robin the neighbour queue with
   the kept prefix, then fill from the baseline tail, `capacity = 20`). Emit the
   same construction at radius 1 as a sensitivity arm.
3. Budget view. Slice the arm with `sliceByCharBudget(E, A.contextCharacters)`.
4. Gold isolation. `evidenceIds` score the result only. Category, reference
   answer and evidence labels must not enter candidate generation, anchor
   selection, neighbour choice or fusion. No cross-user or cross-session
   neighbours.

## Reporting

Per arm (A, D100max as control, E, budget E, radius-1 arms), for multi-hop and
regression separately: n, any / all / recall, wins / losses / ties against A,
exact two-sided binomial p, per-owner improved / worsened counts, mean context
characters and growth over A, plus unresolved-anchor and ambiguity counts.

## Decision rule (fixed before the run)

- If E is not significantly better than D100max on multi-hop all@20, or if the
  equal-character slice removes D100max's gain, stop. v4 multipath remains the
  operating point and adjacency stays recorded as a regression-category
  completeness fix, not a multi-hop lever.
- Parameters are not tuned after seeing results. A different anchor count,
  radius or capacity is a new preregistration.
- A positive result makes E a candidate for a second combination measurement. It
  does not become a product default, and it does not establish answer quality.

## Boundaries

Zero LLM calls, zero retrieval requests, no deployment, no commit by the
authority that runs it, and no edits to the contract owner's scripts, raw
artifacts or the shared contract. The run writes its own results directory and
tests. Guard tests come first: gold never reaches generation, session boundaries
hold, ambiguous anchors are counted, the budget slice is exact, and the control
arms reproduce.

Acceptance is the contract owner's independent recomputation of the run's rows
with the frozen `pairedComparison`, followed by coordinator review. Control-arm
reproduction, paired outcomes, per-owner spread and equal-budget behaviour are
all required; a null result is a valid deliverable.
