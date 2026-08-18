# Namesakes alias/homonym topology evaluation

## Purpose

The LoCoMo topology audit measures natural conversation candidate noise, and
BPID measures independently labelled profile hard negatives. Neither directly
contains labelled alias mentions and same-name references to different
entities. The optional Namesakes adapter fills that narrower evidence gap.

The official [Namesakes dataset](https://figshare.com/articles/dataset/Namesakes/17009105)
contains 4,148 ambiguous Wikipedia entities and 58,862 mentions from Wikipedia
and news. Its Entities split labels each mention `Same` (the page entity) or
`Other` (a different entity with the same or a similar name). The release is
CC BY 4.0. The complete multi-file release is about 216 MB; this evaluation
downloads only the 10,033,495-byte Entities JSONL.

## Protocol

Place the official `Namesakes_entities.jsonl` at:

```text
.benchmarks/namesakes/data/Namesakes_entities.jsonl
```

Then run:

```powershell
npm run eval:topology:namesakes
```

For a bounded smoke run:

```powershell
$env:NMG_NAMESAKES_MAX_ENTITIES = "200"
npm run eval:topology:namesakes
```

The adapter streams JSONL and therefore does not retain the complete release in
memory. For every entity with at least two positive mentions, the first `Same`
mention context is a deterministic local prototype. The remaining `Same` and
`Other` contexts are scored using NMG's local hashing embedder. Gold labels are
consulted only after scoring.

The report includes:

- candidate precision and positive recall across a fixed, fully reported
  threshold curve;
- recall on positive mentions whose normalized surface form differs from the
  page title (alias-like positives);
- rejection of `Other` mentions whose normalized surface form exactly equals
  the page title (hard same-name negatives);
- a streaming counterfactual that treats each non-anchor mention as one online
  arrival, reports how often the score would emit a proposal, and counts the
  foreign records that would be co-located if false proposals were actuated.

No threshold is copied into NMG configuration. The adapter never creates,
submits, accepts, or actuates a topology proposal. Its result is candidate
generation evidence, not calibrated identity confidence.

### Paired Agent attribution probe

The structural audit is complemented by a small, fixed downstream probe:

```powershell
$env:NMG_NAMESAKES_AGENT_CASES = "10"
$env:NMG_NAMESAKES_AGENT_REPEATS = "5"
$env:NMG_NAMESAKES_AGENT_CONCURRENCY = "2"
npm run eval:topology:namesakes-agent
```

For each selected entity, the probe forms two arms from the official labels:

- `clean`: up to three `Same` mention contexts;
- `contaminated`: the identical clean prefix plus a record from a different
  official entity row. An `Other` mention is used only when its normalized text
  resolves uniquely to that row's title; the foreign row's own `Same` context
  must then score at least `0.7` against the target anchor.

The Agent receives the target title and opaque record IDs, then returns the IDs
it attributes to that entity. `Same`/`Other` labels are never exposed to the
model and provide an exact, non-LLM scoring key. Arm order is deterministically
counterbalanced. At most two Pi RPC workers are started, each worker reuses one
process and starts a fresh session for every arm. Responses are content-addressed
under `.benchmarks/namesakes/agent-cache/`, so an identical rerun does not call
the provider again. The fixed prompt prefix also permits provider-side prefix
cache reuse.

## Full official-data result (2026-08-11)

The official file was downloaded from Figshare file `31463402`. It contains
4,148 JSONL rows and its MD5 is
`6224c849f67c8f591e6f7a2f0f02dddf`, matching the Figshare API metadata. The
full read-only run evaluated 3,975 entities and 23,996 non-anchor mentions:
17,294 positives, 6,702 negatives, 16,661 alias-like positives, and 38 exact-name
hard negatives.

| Threshold | Recall | Precision | Alias recall | Exact-name negative rejection |
|---:|---:|---:|---:|---:|
| 0.3 | 1.000 | 0.721 | 1.000 | 0.000 |
| 0.5 | 0.942 | 0.716 | 0.941 | 0.026 |
| 0.6 | 0.675 | 0.694 | 0.672 | 0.395 |
| 0.7 | 0.304 | 0.636 | 0.302 | 0.684 |

The threshold curve has no useful operating point: increasing the threshold
does not improve precision and rejects hard same-name negatives only by losing
most true aliases. The hashing context score is therefore suitable only for
broad blocking/candidate generation. It must not be interpreted as calibrated
identity confidence or used to auto-accept `same_as`/merge proposals.

The online-arrival counterfactual makes the operational cost more concrete:

| Threshold | Proposal rate | Entities with false proposal | Foreign records | Mean / max per affected entity |
|---:|---:|---:|---:|---:|
| 0.5 | 94.74% | 2,307 / 3,975 (58.04%) | 6,450 | 2.80 / 27 |
| 0.6 | 70.07% | 1,995 / 3,975 (50.19%) | 5,140 | 2.58 / 22 |
| 0.7 | 34.42% | 1,479 / 3,975 (37.21%) | 3,003 | 2.03 / 16 |

Even the strictest reported threshold would propose on roughly one third of
incoming mentions and contaminate more than one third of evaluated entities if
proposal equalled merge. This is structural co-location damage, not a simulated
answer score. Hashing may nominate a review set, but only independent evidence
and the existing reversible topology gate may authorize a transform.

## Paired Agent result (2026-08-11)

The corrected fixed ten-entity DeepSeek V4 Flash protocol ran five stochastic
repeats (50 paired observations, 100 model calls) without parse or provider
errors:

| Arm | Exact attribution (Wilson 95%) | Mean precision | Mean recall | Mean latency |
|---|---:|---:|---:|---:|
| Clean | 84% (71.49--91.66%) | 100% | 92.67% | 627 ms |
| One foreign record | 88% (76.20--94.38%) | 100% | 94.67% | 621 ms |

Five paired observations changed from correct to wrong after the foreign record
was added, while seven changed from wrong to correct. The exact two-sided
McNemar p-value is 0.774, and per-repeat deltas were +10, 0, +10, -20, and +20
percentage points. The Agent rejected the foreign record in all 50 contaminated
observations. Across the original live calls the provider reported 6,670
uncached input tokens, 71,040 cache-read tokens, 1,383 output tokens, and 79,093
total tokens under Pi's usage convention. An identical rerun used all 100 local
response-cache entries and made no provider calls.

This repeated run detects neither false attribution nor a stable accuracy
effect. The earlier one-repeat ten-point decline was model variance, not durable
evidence of distraction. The structural audit still justifies proposal-only
similarity, but this Agent probe does not prove downstream false-merge damage,
correction frequency, or end-to-end answer impact.

An earlier pilot incorrectly treated the paragraph surrounding an `Other`
mention on the target page as an entirely foreign record. Those paragraphs
often still described the target (for example, an institute named after a
person), so its apparent 90% to 20% drop was invalid and is not retained as
evidence. Protocol version 1 now requires cross-page record construction.

Generated reports are written beneath `evals/topology/results/`, which is
ignored by Git.

Even after these runs, Namesakes does not contain user correction events and
the paired probe covers only ten fixed entity pairs. Natural attributable
corrections, larger entity coverage, and recovery cost remain separate evidence
gates before unattended identity mutation can be considered.
