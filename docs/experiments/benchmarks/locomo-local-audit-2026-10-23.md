# LoCoMo local audit run (2026-10-23)

[简体中文](locomo-local-audit-2026-10-23.zh-CN.md)

Evidence boundary: complete experiment record (2026-10-23). All retrieval
measurements below are verified local runs through the onlion service entry;
no reader/judge model was invoked, and no official benchmark job, production
rollout, or product code change resulted from this record.

## Question

The online `nmgremote-full-20261020T2327Z` LoCoMo run scored 0.7065
LLM-as-Judge over all 1,540 questions (pipeline complete, zero failures or
skips). Summary-level audit of the user-provided artifacts (report / summary
JSON / xlsx, sha256 `c8453dc7…`, `85cd0590…`, `4ac1f71b…`) verified internal
consistency, but the per-question records (question IDs, retrieved evidence,
answers, judge labels) are not present on this machine, so the failure
position of each miss — ingestion gap, retrieval miss, fusion/truncation loss,
or reader error — cannot be attributed from those files.

This local run exists to produce those per-question records, and afterwards to
serve as the baseline arm for controlled query-decomposition experiments
(budget-matched control arm included) on multi-hop retrieval.

## What the provided artifacts established (summary level)

- Report, JSON and xlsx agree; 1,540 binary judgments sum to 1,088 = 0.7065.
- Versus the rounded timestamp-injection baseline the net difference is −6
  questions of 1,540 (multi-hop −4, temporal +4, open-domain +2, single-hop
  −8). Owner-macro 0.7139 with 95% CI ±4.3pp across 10 owners.
- Reading: aggregate parity, not regression; the "multi-hop shortfall" is a
  long-standing fact (QPP 2026-07-29 recorded multi-hop 0.6559 answer score /
  0.5295 evidence recall), not newly exposed by the remote run.

## Configuration

- Benchmark: LoCoMo, all 1,540 questions, official pinned checkout
  `D:/Github/.benchmarks/official/OmniMemEval` via the repo runner
  (`npm run benchmark:omni -- locomo --config evals/omnimemeval/locomo-audit.config.json`).
- Memory lib: `nmg` (local bridge `evals/omnimemeval/bridge.ts`, direct
  SQLite store) — the sanctioned local path; the `nmgremote` client used by
  the online run is not installed in this checkout.
  This record initially targeted the pinned OmniMemEval python pipeline
  (`npm run benchmark:omni -- locomo --config evals/omnimemeval/locomo-audit.config.json`
  with `--lib nmg`); that route was abandoned after repeated silent background
  spawn failures, and the delivered capture goes through the onlion worker entry
  instead (see Method notes). The nmgremote client used by the online run is not
  installed in this checkout.
- Fresh isolated corpus: `NMG_OMNI_DATA_DIR=<repo>/.benchmarks/omnimemeval-nmg-audit1023`.
- Embedding: local BGE server, `BAAI/bge-small-en-v1.5`, CUDA
  (`bge-venv`, verified `/health` `device:cuda`).
- Retrieval mirrors of the online AML profile where the bridge allows:
  `NMG_QPP_SECOND_PASS=1`, `NMG_CHAIN_INJECTION=logical`, `top-k 20`.
- Phase 1 (`--to-step 2`): ingestion + search only — zero answer/judge LLM
  cost; produces the per-question retrieval records for the audit.
- Phase 2 (`--from-step 3`, not yet run): answer + judge via the AMR endpoint,
  `deepseek-v4-flash`, output cap 300 tokens, thinking disabled (user-specified
  policy for this run). Note: the plain official scripts do not consume the
  online overlay's `OMNI_THINKING`/max-token variables; how phase 2 honors the
  policy is decided before phase 2 starts and recorded here.
- Env file: `.env.nmg-locomo-audit` (gitignored; contains the AMR key).

### Known deltas versus the online run

- Transport: local SQLite store, not the deployed worker/R2.
- Embedding model: local bge-small; the deployed worker's embedding env is not
  recorded in the online report.
- Answer/judge: same model family (`deepseek-v4-flash`); output cap and
  thinking flags may differ from the online overlay's policy.

The audit therefore targets **failure positions**, not exact score
reproduction.

## Results (phase 1, retrieval-only — no reader or judge model)

Capture run `locomo-retrieval-onlion-2026-10-23T08-30-01`: 5,882 messages
ingested through the worker's `/add`, 1,540/1,540 scored questions searched
through `/search` (concurrency 4), **0 failures, 0 lexical fallbacks** (all
`records` mode), search latency mean 399 ms / p95 534 ms (local R2; the online
run's 3.8 s mean includes network and remote R2).

Official audit (`audit-locomo-retrieval.ts`, context-substring matching):

| Metric                      |  Value |
| --------------------------- | -----: |
| any-evidence @20            | 72.99% |
| all-evidence @20            | 58.38% |
| evidence recall             | 54.98% |
| multi-hop evidence recall   | 37.76% |
| temporal evidence recall    | 69.25% |
| open-domain evidence recall | 26.40% |
| single-hop evidence recall  | 72.29% |

(`missingLabels: 8` are dataset evidence labels referencing turns absent from
the stored conversation — a known LoCoMo quirk, not an ingestion failure.)

Per-question failure positions (from `details.jsonl`, evidence-turn text
matching against the ranked retrieval):

| Category         | any@20 |    all@20 | fully-missed questions | mean hops missed | hit rank p50 |
| ---------------- | -----: | --------: | ---------------------: | ---------------: | -----------: |
| multi-hop (282)  |  72.0% | **15.6%** |                  28.0% |             1.96 |            3 |
| temporal (321)   |  77.3% |     70.4% |                  22.7% |             0.36 |            0 |
| open-domain (96) |  45.8% |     24.0% |              **54.2%** |             1.54 |            2 |
| single-hop (841) |  74.7% |     71.9% |                  25.3% |             0.30 |            0 |

Multi-hop miss distribution: 44 questions (15.6%) retrieve every hop; 87 miss
exactly one hop; 76 miss two; the rest three or more. Found hops rank well
(62% inside the top 5), so the binding constraint is per-hop recall inside a
single shared top-20, not ranking quality — the strongest evidence yet for the
caller-side query-decomposition priority, and against leading with setwise
reranking. Open-domain is a coverage failure (over half the questions retrieve
none of the evidence), matching the differentiable-set-logic probe's aspect
finding for coverage questions.

Mapping to the online run: multi-hop any@20 72.0% against its 64.54% answer
score is consistent with a reader that can often answer from partial hops;
the reader-side loss cannot be attributed without phase 2 (answer + judge).

### Multi-hop top-100 probe (same capture corpus, multihop-miss-anatomy-2026-10-23T08-47-39)

Re-searching the 282 multi-hop questions with top_k=100 splits the 880 labeled
evidence hops: 349 in top-20, **59 at ranks 21-100 (6.7%, crowding-out)**,
**472 not found at all (53.6%, query-unreachable)**. all@100 equals all@20 (67
questions) in this old-口径 run; any@100 reaches 80.9% (+8.9pp). Old-口径
caveat: these counts used the raw composite-label parsing and a non-paired
denominator — the v4 paired arms below supersede them (arm B there isolates
the depth variable with 9 wins / 2 losses).

Manual reading of sampled misses (case-sample.json) shows the unreachable hops
are **answer-detail turns**: the retrieved turns discuss the asked topic
("moved from my home country", relationship talk) while the missing hop holds
the specific fact (the place name, the actual status, the concrete activity).
The question's framing words do not occur in the missing hop's text, so a
single query cannot reach it; attribute-style sub-queries ("<entity> <specific
attribute>") target exactly those turns — consistent with the
differentiable-set-logic aspect finding (gold cosine 0.58-0.66 rises to 0.76
under aspect decomposition).

### Static multi-path probes: superseded by the P0-corrected rerun (static-multipath-2026-10-23T10-16-29, T10-14-07)

The first static probe (static-multipath-2026-10-23T09-00-28) fused ONLY the
derived paths — the original query was not in the fusion — so its flat result
(all@20 18.0%, any@20 down to 70.1%) partly measured the arm crowding out the
original's own hits. P0 fixed the arm: the original query is path 0 of the
fusion, per-path pools are parameterized, scoring goes through the frozen
contract (locomo-audit-shared.ts, 6/6 contract tests), and the comparison
reports matched denominators.

Corrected multi-hop results (max fusion, final 20, multi-hop matched rows):

| Arm                             | all@20 | any@20 | evidence recall |
| ------------------------------- | -----: | -----: | --------------: |
| baseline (single query, top-20) |  15.6% |  72.0% |           37.4% |
| paths fused, pools @20          |  19.4% |  73.4% |           39.8% |
| paths fused, pools @100         |  20.5% |  75.5% |           41.6% |

Separation (v4 paired arms, see below): including the original query in the
fusion is the main lever; deepening the pools adds the rest — consistent with
the top-100 probe's 6.7% crowding-out share.

**SUPERSEDED (coordinator review 1792751001798_000705):** the numbers in the
previous two probe sections (first static probe, top-100 probe) come from the
pre-v4 arm and old raw-label口径: non-paired denominators, composite labels
misread, and the fusion omitted the original query. They are retained only for
traceability. The current results are the v4 paired arms below; the earlier
"a larger budget recovers zero fully-covered questions" and "+2.4pp/+4.9pp
static ceiling, no regression loss" statements are withdrawn as conclusions.

### v4 isolated arms on the frozen eligible set (static-multipath-v4-2026-10-23T10-29-58, coordinator-verified 1792752822037_000711)

Eligible projection: 1,974 of 1,986 questions (multi-hop 279; manifest sha256
194ac55a594e…, emitted by emit-locomo-eligible-manifest.ts with per-category
counts and the excluded-ID list). Paired comparisons versus arm A (original
query @20) on the shared n=279 multi-hop set. Arm A on this projection scores
any 73.1% / all 16.1% / recall 38.4% (coordinator-recomputed; the run's own
A-row is in rows.jsonl/raw-candidates.jsonl).

| Arm                                                   | all@20 | any@20 | recall | paired W/L vs A | exact binomial p (two-sided) |
| ----------------------------------------------------- | -----: | -----: | -----: | --------------: | ---------------------------: |
| A baseline                                            |  16.1% |  73.1% |  38.4% |               — |                            — |
| B original @100 -> 20 (isolated depth, +2.5pp all@20) |  18.6% |  75.3% |  40.3% |             9/2 |      0.065 (not significant) |
| D20max paths @20 fused                                |  19.7% |  73.5% |  40.0% |            10/0 |                        0.002 |
| D100max paths @100 requested fused                    |  20.8% |  75.6% |  41.7% |            16/3 |                       0.0044 |

Fixed-text-budget view (each arm sliced to arm A's per-question context
characters): D100max 19.7% (14W/4L, p=0.031); D20max 9W/2L (p=0.065); B 7W/3L
(p=0.34). Regression sample (n=145) is too small to support either direction:
B 1W/1L (p=1), D20max 4W/0L (p=0.125), D100max 4W/2L (p=0.69) — no damage
claim and no harm claim are both unsupported there. Owner stability (multi
all@20): 6 owners improved / 1 worsened / 3 unchanged, net +13 questions, with
the largest single owner contributing 31% of the net gain — not a
single-conversation effect but owner-concentrated.

Contract and numbers were independently reproduced by the coordinator (tests
10/10, manifest hash match, rows-raw cross-recalc 0 mismatches, independent
paired recompute identical, search determinism 139/139 identical positions).
All numbers remain TENTATIVE pending the new agent's independent read-only
review; raw per-path and final ranked {id, content, score} records are
preserved in raw-candidates.jsonl for offline recomputation
(recompute-multipath-summary.ts re-derives the summary from rows.jsonl).

### P2 session-neighbor probe (new agent, cross-verified by me and the coordinator; static-neighbor-2026-10-23T11-07-04)

The neighbor arm (same-session ±1/±2 turns around top-5 anchors, fused with the
kept baseline prefix, final 20) was verified twice: I recomputed every paired
number from its raw rows through the frozen contract (field-for-field match),
and the coordinator re-derived it with an independent implementation. Verified
numbers, paired versus arm A on the shared eligible denominator:

| Scope              | Arm                 | all@20 |  Δ vs A |  W/L |                 exact p |
| ------------------ | ------------------- | -----: | ------: | ---: | ----------------------: |
| multi-hop (n=279)  | C2 radius 2         |  19.4% |  +3.3pp | 16/7 | 0.093 (not significant) |
| multi-hop          | C2 same-char budget |  17.9% |  +1.8pp | 12/7 | 0.359 (not significant) |
| multi-hop          | C1 radius 1         |  17.9% |  +1.8pp | 10/5 |                   0.302 |
| regression (n=145) | C2                  |  86.9% | +11.7pp | 21/4 |                  0.0009 |

Mandatory interpretation boundaries (coordinator 1792754718590_000734 initial
reading; corrected with measured split by 1792756765569_000763):

1. Multi-hop shows NO significant gain — full-budget +3.3pp (p=0.093) shrinks
   to +1.8pp (p=0.36) under the same-character budget. This is consistent with
   the earlier anatomy (53.6% of hops unreachable at top-100; only ~27.7% of
   missing hops sit within ±2 turns): adjacency pages through session order to
   recover turns outside the similarity recall radius, it does not perform
   multi-hop reasoning.
2. The regression gain (+11.7pp, p=0.0009) is large but comes from the
   1-in-8 deterministic guardrail sample (temporal + single-hop, n=145). It
   records an adjacency completeness fix, and the measured mechanism is a
   **recall-radius problem, not a budget problem**: of the 23 evidence turns C2
   rescued in the regression category, 0 were in the original top-20 (by
   definition), only 4 sat at ranks 21–100 of the original top-100 (true budget
   crowding-out), and 19 were completely unreachable by the original query's
   ranking — D100max covers just 2 of the 23, so the multipath fusion misses
   them too. The turns the original query hits are topic-adjacent (sharing the
   question's wording); the specific facts and dates live in same-session
   neighbouring turns with almost no lexical overlap, which similarity ranking
   cannot recall — adjacency pages through session order and bypasses
   similarity. Not a product-level benefit claim; no extrapolation to answer
   scores.
3. Cross-arm comparison on the same 279-question multi-hop set: C2 all@20
   19.4% < D100max 20.8%, any@20 comparable (75.3 vs 75.6) — adjacency does NOT
   replace multi-path fusion; the mechanisms differ.

Next step (requires new measurement; additivity must not be assumed): the only
combination worth testing is the D100max candidate pool with neighbor
expansion, keeping the final-20 and same-character-budget views, multi-hop as
the primary scope with regression reported. If the union is not significant or
eats D's gain, the round stops at v4 and adjacency is recorded as a
regression-category completeness fix.

### Arm E combination (new agent, per preregistration; cross-verified by me — static-arm-e-2026-10-23T12-15-22)

Executed per the frozen preregistration. Controls reproduced first (A, D100max,
C2 exact). My independent recomputation from arm-e-rows.jsonl via the frozen
contract matches the delivered summary field-for-field, and I independently
confirmed the paired E-vs-D100max comparison (W12/L16).

Multi-hop (n=279, paired vs A):

| Arm                                     | all@20 |                     paired vs A |      p |
| --------------------------------------- | -----: | ------------------------------: | -----: |
| D100max (v4 operating point)            |  20.8% |                          16W/3L | 0.0044 |
| E = D100max pool + adjacency (radius 2) |  19.4% | vs D100max 12W/**16L**, p=0.572 |      — |
| budgetE (same-char slice)               |  17.6% | vs budgetD100max 19.7%: 15W/11L |      — |
| E1 radius 1                             |  19.7% |                 15W/5L, p=0.041 |      — |

**Both preregistered stop conditions triggered**: (1) E is not significantly
better than D100max — net −4 questions, direction negative; (2) the
same-character slice eats D100max's budgeted gain (+3.6pp → +1.5pp). Per the
fixed decision rule the round **stops at v4**: the multi-hop operating point
remains D100max (20.8%), no parameter additions.

Regression guardrail (n=145): E 90.3% (23W/1L, p<1e-5) — stronger than either
single arm. Most of the turns it recovers appear in no retrieval candidate list
at all (question-level: 3 in a derived clause but unselected and 16 outside
every list, versus 4 crowded out of the pool tail), so it is recorded as a
regression-category completeness fix under the recall-radius mechanism; not a
multi-hop claim and not extrapolated to answer scores.

Side note from the new agent (no data impact; workerUserId and fileKey coexist
in every row): the v4 fileKey is the conversation ordinal in dataset order
(conv-26→_0, conv-30→_1, …), not a question-cumulative index; joins across
artifacts should use workerUserId as the canonical side.

### Clause ablation: two clauses suffice (new agent, board 1792761231656_000790; cross-verified by me — clause-ablation-2026-10-23)

Which of D100max's two derived clauses actually pays? Recomputed from the
existing v4 raw (no new retrieval, zero LLM); my independent recomputation
matches the delivered summary on every arm and on the cross-arm pairing.
Multi-hop n=279, paired vs A:

| Clause set                          |    all@20 | paired vs A |            p |
| ----------------------------------- | --------: | ----------: | -----------: |
| original only (requested 100 -> 20) |     18.6% |       9W/2L | 0.065 (n.s.) |
| original + **content words**        | **20.1%** |      14W/3L |   **0.0127** |
| original + aspect terms             |     19.4% |      11W/2L |       0.0225 |
| original + both (= D100max)         | **20.8%** |      16W/3L |       0.0044 |

- **Aggregate direction: plusContent vs plusBoth = 0W/2L (277 ties), p=0.5.** That
  is the aggregate over all multi-hop questions, and it says the full set wins
  exactly 2 more questions than the two-clause set. The aspect clause is not
  therefore "harmful" — see the restricted subset below.
- **On the questions where the aspect clause actually exists**
  (`raw.derived20.length === 2`, n=62 of 424), plusBoth **vs** plusContent is
  **3W/1L** (58 ties): all@20 43 -> 45, a net **+2** questions. On the multi-hop
  subset of those (n=22) it is **2W/0L**: 10 -> 12. Note the direction: the
  summary's `pairedVersusFull.plusContent` = 0W/2L is _plusContent against
  plusBoth_, i.e. the same two questions read the other way round, not a
  contradiction.
- The ablation construction is clean on the rest: on the **362** questions where
  the aspect clause does not exist, plusBoth and plusContent have
  **identical hit positions in all 362** (0 differences), so the third clause
  simply never ran there.

Both restricted-subset figures are emitted by the ablation summary as
`byDerivedPathCount`, which `clause-ablation.ts` produces from
the recorded candidates with:

```text
node --experimental-strip-types evals/omnimemeval/research/audits/clause-ablation.ts \
  --raw evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/raw-candidates.jsonl \
  --rows evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/rows.jsonl \
  --out <output-directory>
```

The emitted field carries exactly these numbers: cohort `2` gives
`pairedPlusBothVsPlusContent {allBefore: 43, allAfter: 45, wins: 3, losses: 1,
ties: 58}` and `multiHop {n: 22, allBefore: 10, allAfter: 12, wins: 2, losses: 0,
ties: 20}`; cohort `1` gives `diffCount: 0` with
`plusBothEqualsPlusContent: true` and 362 ties. Regenerating the run added only
this derived block: `ablation-rows.jsonl` is byte-identical to the previously
delivered run (verified with `cmp`), so no earlier figure moved. The 362-question
identity is asserted in the ablation test rather than only reported, and that
test also pins the cohort pairing against the frozen `pairedComparison` field by
field, so this implementation cannot drift from the scoring contract.

- The aspect path only exists on 62 of 424 questions (the content-word clause
  exists on 362), so its surface area was already small.
- Regression (n=145): plusContent and plusBoth are **identical** (76.6 / 82.1
  / 75.5, 4W/2L) — the aspect clause contributes nothing outside multi-hop.
- Equal-character budget: plusContent 19.0% (p=0.077, marginal) versus plusBoth
  19.7% (p=0.031, significant). A **2-clause** design is therefore defensible
  for the 20-item page, while claiming the _budgeted_ significant gain still
  needs the third clause. Recorded as a design choice, not a settled product
  default: dropping the aspect clause costs 2 all@20 on the 62 questions that
  have it (2 of 22 in multi-hop) and saves 62 calls (910 -> 848, −6.8%;
  multi-hop 580 -> 558, −3.8%). **Only call counts were measured; latency and
  end-to-end benefit were not measured in this round.**

Union sizes use the deduplicated caliber (normalized content), which is what the
oracle's <=20 constraint and any availability claim must use: **mean 62.1** for
multi-hop (57.3 regression). The sum of the individual clause lists is **mean
140.4** (132.1 regression) because the same record recurs across every path
that returned it; quoting that sum as "candidates per question" overstates what
was available. The `55` figure that appeared in earlier hand arithmetic was the
median over **all 424 eligible questions**; this section reports the multi-hop
subset (279), whose median is `56` — a scope difference, not a convention
difference.

### Requested depth versus actual return

Each clause requests a `top_k`, and the server applies its own graph, hierarchy
and token budgets on top of that, so a clause can return fewer records than
requested. The "100" in D100max is the per-clause request value, not a page
size. Measured on the v4 run (`derived100` holds one list per derived clause):

| Scope                                  | p25 | p50 | p75 | max | mean |
| -------------------------------------- | --: | --: | --: | --: | ---: |
| original-query clause, all 424 rows    |  25 |  43 |  62 | 100 | 44.8 |
| original-query clause, multi-hop n=279 |  25 |  43 |  62 | 100 | 48.5 |
| all @100 clause lists (910 lists)      |  25 |  43 |  62 | 100 | 44.9 |

886 of the 910 lists returned fewer than 100 records and 24 returned the full 100. `derived20` likewise holds one list per derived clause (p50 = 20 per list);
on the 62 questions that carry two derived clauses the per-question derived
total reaches 40.

**Where the rescued turns actually sat (C2 versus E).** For each evidence turn
newly covered in the regression category, its position was looked up in the
original query's requested-100 pool (`raw.B_full`) and in the derived clause
lists: rank < 20 in the original pool means it was already in the baseline arm,
rank >= 20 means genuine crowding-out, presence only in a derived clause list
means it was ranked but not selected into the page, and absence everywhere
means no retrieval path surfaced it. Two counting calibers apply and both are
reported, because only the question-level one feeds `all@20`:

| Caliber                                                 | Arm | rescued turns | crowding-out | in a clause list, not selected | outside every candidate list | already in A |
| ------------------------------------------------------- | --- | ------------: | -----------: | -----------------------------: | ---------------------------: | -----------: |
| question-level (only questions that flipped to all-hit) | C2  |            23 |            4 |                              3 |                           16 |            0 |
| question-level                                          | E   |            25 |            4 |                              4 |                           17 |            0 |
| label-level (any label turning from -1 to a rank)       | C2  |            24 |            5 |                              3 |                           16 |            0 |
| label-level                                             | E   |            26 |            5 |                              4 |                           17 |            0 |

The single-turn difference is `conv-48:15` ("What pets does Jolene have?",
category 4): A = `[-1,-1,-1]`, C2 = E = `[-1,-1,5]`. That question never becomes
fully hit — two of three turns stay missing — so it counts no win and never
enters `all@20`; only its third label is newly covered (pool rank 69). The two
calibers are therefore both correct for their purpose, and the difference
changes no score.

The split into three buckets matters: a recovered turn can sit at the tail of
the original query's pool (crowding), appear in one of the derived clause lists
without being selected into the final page (ranked, not selected), or appear in
no retrieval candidate list at all (context-only). Only the middle bucket is a
selection problem; the third is a recall-radius problem. Measured with the
refined three-way split, both calibers agree: **about two thirds of the
adjacency rescues are outside every candidate list** (16/23 = 69.6% and
16/24 = 66.7% for C2), and E's two extra rescues over C2 are one
clause-list-but-unselected turn and one outside-every-list turn, with the
crowding-out count unchanged (4 to 4, or 5 to 5). The diagnostic now computes
that delta rather than leaving it to hand derivation: field
`derived.rescueLocusDeltaEminusC2` reports `{original-pool-tail: 0,
other-path-unselected: 1, outside-all-paths: 1}` for both calibers, so the
invariant is machine-checked on every rerun.

Independently reproduced by the neighbour-probe agent and by me from the same
artifacts (question-level C2 4/3/16 of 23, E 4/4/17 of 25; label-level C2
5/3/16 of 24, E 5/4/17 of 26). Under the question-level caliber

the four crowding cases sit at pool ranks 42–47 (conv-43:93 @42, conv-47:62 @32,
conv-47:142 @47 and @43), close to the measured pool p50 of 43; the label-level
extra case (conv-48:15 @69) lies beyond p50, so "crowded cases sit at the page
edge" is a question-level statement only.

This supports the recall-radius reading from the E side: most adjacency rescues
sit outside every retrieval candidate list, and pairing adjacency with a deeper
wider pool adds rescues from outside the lists rather than from the page tail.

### Loss decomposition: where the multi-hop gap actually lives (loss-decomposition.ts; cross-verified by an independent implementation)

Diagnostic over existing artifacts only (`static-multipath-recall` raw), zero LLM,
zero new retrieval, no new run artifacts. Reproduce with
`node --experimental-strip-types evals/omnimemeval/research/audits/loss-decomposition.ts`;
its 16 guard tests live in `tests/evals/locomo-loss-decomposition.test.ts`.

**Oracle definition (exact, not an estimate).** A question is candidate-reachable
when three conditions hold together: every atomic evidence label (official
semicolon/comma splitting) has at least one covering candidate in the pool; the
cheapest covering record set is **<= 20 records**; and those records' characters
sum to **<= that question's arm-A character budget**. The candidate pool is the
union of every query path's list — `raw.A`, `raw.B_full`, flattened `derived20`
and `derived100` — deduplicated by normalized content. On both scopes the
budget-blocked count is **0**, so the ceiling below is decided entirely by
whether the labels appear in the union at all.

| Scope            | union ceiling (all@20) | labels missing from union | budget-blocked | final page (D100max) | fusion loss | query/representation loss |
| ---------------- | ---------------------: | ------------------------: | -------------: | -------------------: | ----------: | ------------------------: |
| multi-hop n=279  |         **29.0%** (81) |           **198 (71.0%)** |              0 |       **20.8%** (58) |   **8.2pp** |                **71.0pp** |
| regression n=145 |            82.1% (119) |                26 (17.9%) |              0 |          76.6% (111) |       5.5pp |                    17.9pp |

Supporting figures (multi-hop): union any-hop 84.2%, union hop recall 51.6%
(448/868), final-page hop recall 41.7% (362/868).

**Candidate size — two calibers, both reported.** Deduplicated by normalized
content (the caliber the ≤20-slot constraint and any availability claim must
use): multi-hop **mean 62.1, p25 35, p50 56, p75 81, max 162**; regression mean
57.3, p25 35, p50 52, p75 74, max 138. Sum of the individual clause lists (same
record counted once per path that returned it): multi-hop **mean 140.4, p25 90,
p50 127, p75 164, max 360**; regression mean 132.1, p25 90, p50 126, p75 162,
max 311. Quantiles use the repository's `percentileNearestRank` convention
(`tools/parts/stats.ts`, the same one `audit-locomo-retrieval.ts` uses), so the
figures above are reproducible from the diagnostic command. Quoting the path sum
as "candidates per question" overstates what was available.

**Retrieval calls (recorded fact, not an estimate).** Per question = 1 (original
query) + the number of derived clauses that actually existed. All 424 questions:
2 calls for 362, 3 calls for 62, total 910. Multi-hop 279: 2 calls for 257, 3
calls for 22, total 580. The 424x2+62 = 910 total matches the 910 recorded @100
clause lists, so both figures come from the same accounting. Dropping the aspect
clause removes one call on the 62 questions that had it: 910 -> 848 (-6.8%);
multi-hop 580 -> 558 (-3.8%).

**Adjacency raises the ceiling only when it is paired with the union, not with
the fused page.** Ceilings on the same oracle, multi-hop n=279 (independently
reproduced from the artifacts by me, and by the neighbour-probe agent):

| Candidate set                                |   oracle all@20 |
| -------------------------------------------- | --------------: |
| retrieval union only                         |  81 (**29.0%**) |
| union + E pool (D100max-anchored ±2)         |     101 (36.2%) |
| union + C2 pool (A-anchored ±2)              |     100 (35.8%) |
| union + both pools                           | 103 (**36.9%**) |
| **Arm E's own input** = D100max(20) ∪ E pool |  **79 (28.3%)** |
| **Arm C2's own input** = A(20) ∪ C2 pool     |  **69 (24.7%)** |
| D100max page                                 |      58 (20.8%) |

Arm E's shortfall therefore has **two layers, not one**: its input ceiling
(28.3%) was already **below** the retrieval union's own ceiling (29.0%), because
an arm keeps only its fused 20-record page plus its own adjacency pool and
discards the rest of the union; on top of that the allocation layer cost a
further 8.9pp (28.3% -> 19.4%). "Adjacency raises the ceiling" holds for the
combination _union + adjacency_, which is not what Arm E built.

The two anchoring strategies are near-redundant: either pool alone is worth
+6.8 to +7.2pp and both together only +7.9pp, so one adjacency pool is enough.
The 35.8% figure quoted below as a conservative lower bound is exactly the
_union + C2 pool_ construction, so it was a genuine lower bound rather than a
coincidence. The testable direction that follows is to merge adjacency candidates
**into the candidate set** and let one selector cut to 20 records, instead of
cutting the page first and padding it with neighbours as Arm E did.

Boundary: 36.9% is the value for the tested configuration (radius 2, first 5
anchors); a wider radius was not measured, so it is not a mechanism ceiling. The
arm-input ceilings are emitted by the diagnostic as `derived.armInputCeiling`
(`{multihop: {questions: 279, page: 58, E: 79, C2: 69}}`), whose `convention`
field states each arm's input construction (E: its fused page plus the
arm-E ±2 pool via `buildArmE` anchors 5 / radius 2 / keepBaseline 10; C2: arm-A's
20 records plus the C2 ±2 pool via `buildNeighborArm`, same parameters) and that
these are **arm inputs, not the union-plus-neighbourhood ceiling**.

**Reading.** The fusion layer has only 8.2pp of slack and no budget blocking;
71.0% of multi-hop questions have a gold label that no recorded query path ever
surfaced. That is the quantitative reason every fusion-side variant tested so
far (depth tiers, multi-path max/round-robin, this round's adjacency fusion)
stalled around 20% all@20: on the query paths in use, the ceiling was 29%.

Two things this does NOT say. It does not say selection is worthless — the 8.2pp
of fusion slack is real, just smaller than the query-side gap. And it does not
say only query expression or representation can raise the ceiling: the adjacency
pools raised it to 36.9% without touching any query, so **structural expansion
is a second ceiling-raising family**, alongside query expression and
representation. Whether structural expansion pays off end-to-end is a separate
question this round answered negatively for the tested 20-slot fusion.

What the 198 questions do NOT yet establish: whether a missing label is missing
because the question lacks the cue, because the turn's stored representation
lacks its surrounding context, or because retrieval internally trimmed before
returning. "Outside the recorded candidate pool" is an observational locus, not
a causal diagnosis of a particular embedding model or query method.

**Estimate boundaries.** Single-run local capture (bge-small via the onlion
entry, local R2); ceilings are computed against labeled evidence only and say
nothing about answer scores; "fusion loss" is the oracle-to-page gap under the
same final 20 records and the same character budget, not a claim that a
selector can realise it. The 36.9% adjacency figure is the union ceiling of
this diagnostic's query paths plus the tested adjacency pool — it is not, by
itself, the exact ceiling of Arm E's own candidate input, and it does not
transfer to a wider radius.

## Method notes and deltas

- Retrieval entry: the deployed onlion worker surface (`/add`, `/search`) on
  `wrangler dev` with local simulated R2 — the product path, not a direct
  store call. No leaderboard or judge model was invoked.
- Ingestion mirrors the online run's shape: one user per conversation,
  speaker-prefixed content, roles normalized from the speaker mapping,
  session datetime as `chat_time`. No evidence-turn importance prior (the
  `evals/benchmarks/run.ts` convention of 0.9 for official evidence turns is
  deliberately NOT applied — it would leak oracle information into an audit).
- Deliberately different from the online run: local BGE embeddings (the
  deployed worker's embedding env is unrecorded), local R2, no network.
  This measures the onlion retrieval profile's evidence ceiling, not the
  online deployment's absolute recall.
- The capture script keys results by dataset array index
  (`locomo_exp_user_<index>`) as `audit-locomo-retrieval.ts` expects.

## Conclusion and decisions

The gap splits into three layers, each with its own lever; every reading below
belongs to one of them.

1. **Candidate missing.** 198 questions (71.0%) miss at least one gold label from
   every recorded query path, and the candidate union ceiling is 29.0%. Those
   71.0pp can only move by changing the query expression or the representation
   (including a decomposer, cancelled on cost), so this round ends here.
2. **Cut page.** The candidate is in hand but not among the twenty records. The
   adjacency pool's ceiling is 36.9% (radius 2, first 5 anchors) while its own
   page reaches 19.4% — **17.5pp is decided by who makes the page**. The lever
   there is allocation (supplement, budget, selection), and it measures: five
   appended neighbour records take multi-hop 20.8% -> 23.7% and
   temporal+single-hop 76.6% -> 84.1%; twenty reach 28.3% / 92.4%.
3. **Final allocation.** The content is already in the page; what remains is its
   position and form in the answer context. At the reader stage the page scores
   61.4% and a tail append reaches 84.1%, while an anchored arrangement reaches
   79.3% (3W/6L, p=0.51) and explicit relation markers 76.8% (2W/7L) — neither
   beats a plain append. **Placement is not the variable; content is.**

Two earlier generalisations are therefore withdrawn: (a) "multi-hop is not a
ranking problem" — ranking among retrieved hops is indeed not the bottleneck
(62% of hits sit in the top 5), but allocation among candidates into the page is
not neutral, and layer 2's 17.5pp is decided by it; (b) "raising the ceiling
requires changing the query expression or representation" — true only for layer
1, since layer 2's ceiling was raised by allocation in measurement.

- The online nmgremote full run and the timestamp-injection baseline are at
  aggregate parity; no regression claim is supported (summary-level audit of
  the provided artifacts).
- Multi-hop retrieval is the binding weakness, constrained both by candidate
  missing (71.0pp) and by page allocation (17.5pp inside the reachable band);
  the layering is above. The isolated depth arm (B) and the multi-path fused arms
  (D) both improve all@20 with paired wins exceeding losses (16/3 at D100max). The old-口径 "a larger budget
  recovers zero fully-covered questions" reading is withdrawn.
- Static multi-path recall, measured on the P0-corrected v4 paired arms
  (coordinator-verified): D100max delivers **+4.7pp all@20 (16W/3L, p=0.0044)**
  and **+3.6pp under the same per-question text budget (14W/4L, p=0.031)**;
  the isolated-depth arm B alone is not significant (9W/2L, p=0.065). The
  earlier +2.4pp "flat" and +4.9pp "ceiling" figures came from broken or
  non-paired arms and are withdrawn as conclusions.
- Arm E (D100max pool + adjacency, preregistered, cross-verified): BOTH stop
  conditions triggered — E vs D100max 12W/16L (p=0.572, net −4 questions) and
  the same-character slice eats D100max's budgeted gain (+3.6pp → +1.5pp). Per
  the fixed decision rule the multi-hop work point STOPS at v4 (D100max
  20.8%); adjacency is recorded only as a regression-category completeness fix
  (regression E 90.3%, 23W/1L).
- Clause ablation (clause-ablation-2026-10-23, cross-verified): multi-hop all@20 is
  18.6% for the original-query pool, 20.1% with the content-word clause (14W/3L,
  p=0.013), 19.4% with the aspect clause, and 20.8% with both (16W/3L,
  p=0.0044). The two-clause set is 0W/2L against the full set (p=0.5); the
  aspect clause exists on only 62 of 424 questions and contributes nothing on
  the regression categories. On the questions where it does exist, however,
  plusBoth **vs** plusContent is 3W/1L (43 -> 45, net +2; 2W/0L, 10 -> 12 on the
  22 multi-hop ones), and on the 362 questions without it the two arms are
  position-identical — so the clause earns a small but real place rather than
  doing harm. Under the same character budget, two clauses give 19.0% (p=0.077)
  against 19.7% (p=0.031) for three. Dropping the aspect clause therefore
  removes one retrieval call on those 62 questions only — the other 362 never
  had a third clause — and p=0.5 does not establish equivalence; it records no
  aggregate loss. Only call counts were measured; latency and end-to-end
  benefit were not measured in this round. A
  "significant under equal budget" claim still needs the third clause.
- Cause of the adjacency gains (question-level caliber; both calibers recorded
  above): C2 rescued 23 evidence turns — 4 crowded out of the original pool
  tail, 3 present in a derived clause list but not selected, 16 in no candidate
  list at all; E rescued 25 (4 / 4 / 17). E's two extra rescues over C2 are one
  clause-list-but-unselected turn and one outside-every-list turn, with the
  crowding count unchanged. About two thirds of the rescues (16 of 23) lie
  outside every retrieval candidate list, so the dominant cause is recall
  radius rather than the 20-record budget — with a small selection component.
- Loss decomposition (loss-decomposition.ts, cross-verified by an independent
  implementation): on multi-hop the candidate-union ceiling is **29.0%** all@20
  with **198 questions (71.0%)** missing at least one gold label from every
  recorded query path, and **0** questions blocked by the 20-slot or character
  budget. Fusion therefore has only **8.2pp** of slack against the page's
  20.8%, while **71.0pp** of the gap is query/representation. Adjacency lifts the
  ceiling to 36.9% (radius 2, first 5 anchors; not measured wider) yet its page
  came in at 19.4%, so its binding constraint is allocation, not availability.
  Fusion-side variants stall near 20% because they all compete inside layer 2 for
  the same twenty slots while layer 1's 71.0pp stays untouched; moving adjacency
  outside the page instead of into the contest takes the same candidates to 23.7%
  (five records) / 28.3% (twenty). "Changing the query expression or
  representation" holds only for layer 1.
- Open-domain is dropped from this effort by decision: most of its gap needs
  world knowledge beyond the stored conversation. (Captured note: 54.2% of
  open-domain questions retrieved zero evidence, so a retrieval-shaped slice
  exists if that category ever matters again — recorded, not pursued.)
- The LLM query decomposer was CANCELLED by the user (cost) and is not a
  planned lever in this workstream. Under the zero-LLM, no-embedding-change
  constraints, the query-side shapes measured this round end at the v4
  numbers above. The session-neighbor probe (P2) verified: multi-hop NOT
  significant (+3.3pp p=0.093; budget +1.8pp p=0.36); regression guardrail
  +11.7pp (p=0.0009) recorded as a completeness fix, not a product claim;
  adjacency does not replace multi-path fusion (C2 19.4 < D100max 20.8). The
  D100max pool plus neighbour expansion was measured as Arm E and stopped at v4
  under the preregistered rule (see above); no further combination is added in
  this round.
- Phase 2 (answer + judge over the AMR endpoint) remains available to quantify
  the reader-side conversion loss (multi-hop any@20 72.0% against the online
  64.54% answer score), but no reader-side change is planned before the
  decomposer decision.

## Status

Complete. Phase 1 (retrieval-only audit), the multi-hop top-100 probe, and
both static multi-path probes are finished and recorded above. Tooling lives
in `evals/omnimemeval/research/audits/` (`capture-locomo-retrieval-onlion.ts`,
`multihop-miss-anatomy.ts`, `static-multipath-recall.ts`,
`static-prf-recall.ts`); result directories under `evals/locomo/results/`.
The OmniMemEval checkout was merged with upstream MemTensor/main (merge
`2e1de28` on `fix/eval-checkpoint-batching`; opencode's uncommitted WIP is
preserved in that checkout's stash). No product code change, no official
benchmark job, and no production rollout resulted from this record.
