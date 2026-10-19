# Differentiable set logic

[简体中文](differentiable-set-logic.zh-CN.md) · [Terms used](differentiable-set-logic.terms.yaml)

**Authority:** [Parent scope](../memory-graph-reasoner.md).

Evidence boundary: The outcomes below are findings from their reported
research-probe runs, not fresh verification or current product-performance
claims. These probes are diagnostic and do not define the public benchmark
execution path or runtime defaults; see the [research utilities guide](../../../../evals/omnimemeval/research/README.md).

### Differentiable set logic

Beyond chained traversal, MGR provides fuzzy set logic over the same node
vectors, implemented entirely inside the autodiff DAG (`LogicExpr`,
`logicSearch`, `trainLogic`). An atom maps every node to a membership
`σ(τ·cos(v, q))` — a soft set — and combinators are t-norm operators:
AND = product (intersection), OR = probabilistic sum (union), NOT = complement.
The only parameter is a global sharpness `τ`, trained contrastively.

A July 2026 qualitative probe (`evals/omnimemeval/research/probes/mgr-logic-probe.ts`) ran the
operators on real LoCoMo multi-hop failures with BGE record embeddings:

- **Conjunctive questions are the sweet spot.** For "Which city have both
  Jean and John visited?", a single-vector query missed the second hop
  entirely, while `and(cities Gina visited, cities Jon visited)` recovered
  "trip last week to Rome" at rank 3 and kept the bridge turn (which mentions
  both Paris and Rome) at rank 1.
- **NOT is dangerous with broad atoms.** `and(promotion, NOT business talk)`
  collapsed all memberships to ≈0.02 and returned noise: near neighbours of
  the negated concept get suppressed along with the target. NOT atoms must be
  narrow, or the operator needs a learned damping exponent.
- **AND over-constrains coverage questions.** "How did Gina promote her
  store?" needs several dissimilar evidence turns, each matching only one
  atom; the product t-norm punished exactly those turns. Constraint questions
  want AND; coverage questions want OR or plain ranking with diversity.

One incidental finding: the pure-vector baseline in the probe outperformed the
production bridge on one question, reinforcing that bridge-level reranking
(actor policy, FTS interplay) can lose evidence that raw record vectors keep.

A second round of probes on the coverage failure ("How did Gina promote her
clothes store?") isolated the remaining bottleneck with hard numbers:

- **Metadata filtering is necessary but not sufficient.** Restricting
  candidates to Gina's turns (`source_actor`) removed the other speaker's
  noise, yet 3 of 4 gold turns still missed top-20.
- **The embedding's relevant band is too narrow.** Gold turns sit at cosine
  0.58--0.66 against the question, while the top-20 cut is ≈0.619 and the
  corpus median is 0.542 — a ~0.14 corridor where signal and filler mix.
  Aspect-decomposed sub-queries scored gold higher (up to 0.76), but the
  union of aspects is equally crowded. In this probe, the misses are consistent
  with a limitation of the tested BGE embedding setup, not evidence that the
  set operator itself failed; coverage misses at this level may need a
  stronger embedder or a larger budget (the K=40 ablation already showed the
  budget trade-off).
- **Fixed τ saturates real embedding distributions.** With the default
  τ = 8, on-topic memberships all collapse to ≈1.0 and OR/AND rankings
  degenerate into tie noise; τ ≈ 1 restores ordering. Membership sharpness
  must be calibrated per embedding space (or learned via `trainLogic`)
  before set logic composes meaningfully on real vectors.

Two derived operators complete the set: `nand(...)` = NOT(AND), functionally
complete but an anti-selector on its own (irrelevant nodes rank highest, so it
is only a building block or a differentiable conflict penalty — e.g. training
superseded states not to co-activate); and `xor(a, b)` = OR·NAND, which ranks
evidence belonging to exactly one side above ambiguous both-sides statements.

A follow-up BEAM probe (`evals/omnimemeval/research/probes/mgr-xor-probe.ts`, conversation 1
contradiction_resolution questions) produced a negative result for this sample:
**XOR failed on the tested real embeddings because they did not separate
negation from topic.** "Never wrote Flask routes" and "implemented Flask
routes" occupied the same region of vector space, so every on-topic message
was a both-sides member and XOR suppressed the contradictory evidence it was
intended to surface (top ranks filled with off-topic noise). `and(never, did)`
degenerated into plain topic retrieval — which did find the gold messages,
but so did the unmodified question vector (rank 3--4). For these inputs, the
probe does not support solving contradiction detection with retrieval-side set
logic over vanilla embeddings; it supports adding polarity-aware signals (e.g.
NMG's `truth_status`/conflict metadata or reader-side detection). XOR can still
be useful when the two atoms occupy distinct vector regions.

A third probe tested the vector-native rescue for negation: a polarity axis
estimated as the mean difference of generic "never did X" vs "did X" sentence
pairs. The axis failed to transfer — gold contradictory messages landed
mid-pack (ranks 167/188 and 127/188), and its direction was essentially
orthogonal to the gold pair's own difference vector (cos 0.042). Sentence
differences in this sample are dominated by topic rather than polarity:
**the tested bge-small-en sample provided no transferable linear negation
direction.** An axis fitted to minimal polarity pairs per domain might do
better, but that is a fragile per-domain artifact; the metadata/reader route
remains the accepted one.

A minimal-pair k-NN test (`evals/omnimemeval/research/probes/negation-knn-probe.py`, ten
affirmative/negative sentence twins) found the same pattern for each tested
model in this ten-pair sample. For every embedding model tested, a negated
sentence's top-1 neighbour was its own affirmative twin, not another negation:

| Model | twin-as-top1 | cos(neg, twin) | cos(neg, best other neg) |
| --- | -----------: | -------------: | -----------------------: |
| bge-small-en-v1.5 | 9/10 | 0.823 | 0.671 |
| Qwen3-Embedding-0.6B | 10/10 | 0.861 | 0.556 |
| gemini-embedding-001 | 10/10 | 0.881 | 0.654 |

In this small sample, each tested model placed negated statements closer to
affirmative twins than to other negations, consistent with topic similarity
dominating polarity for these examples; this does not establish a universal
embedding limitation. For retrieval that must distinguish logical polarity,
the result supports extracting and storing explicit write-time record metadata
(e.g. `polarity` + `predicate_key`) rather than relying on vector similarity
alone.

A write-time extraction prototype validated that route end to end
(`evals/omnimemeval/research/polarity/polarity-extract.py`, `evals/omnimemeval/research/polarity/beam-polarity.py`,
`evals/omnimemeval/research/polarity/polarity-pairs.py`). `memory_records` gained three nullable columns —
`confidence` (REAL), `polarity` (`affirmative`/`negative`), `predicate_key`
(canonical snake_case predicate) — filled by a cheap pipeline: regex negation
cue filter, then a fixed weak LLM (deepseek-chat, temp 0) extracts polarity +
predicate key + confidence, for cue-hit records plus their top-3 embedding
neighbours. Findings:

- **The BEAM contradiction pair is detected as a deterministic join.** On
  BEAM 100K conversation 1 (188 messages), msg-24 "I'm trying to implement
  the basic homepage route with Flask" extracted as
  `affirmative / user_implemented_homepage_route_with_flask` and msg-58
  "I've never written any Flask routes..." as `negative /
user_written_flask_routes`. After key canonicalisation (below) both land on
  one `predicate_key` with opposite polarities, so contradiction detection
  becomes `SELECT ... WHERE a.predicate_key = b.predicate_key AND a.polarity
<> b.polarity` — zero embedding math at query time.
- **LLM predicate keys are not canonical across paraphrases.** A single-pass
  extractor produced `user_implemented_homepage_route_with_flask` vs
  `user_written_flask_routes` for the same fact and the join missed. A second
  pass clustering keys by embedding (bge-small, cosine ≥ 0.85, union-find)
  merged 181 raw keys into 96 clusters and recovered the pair. Canonical
  keys need either this merge pass or vocabulary-constrained extraction.
- **Key clustering over-merges at high threshold.** One union-find chain
  collapsed ~90 `assistant_provided_*` keys into a single cluster (all
  assistant turns look alike as keys). Precision on contradiction pairs
  survived because over-merge hit same-polarity keys, but the merge needs
  polarity-aware guarding (never merge across polarities) before it is safe.
- **LoCoMo user_1 has essentially no factual negations.** 88 cue hits, 0 true
  negatives — all matches were idioms ("can't wait", "won't quit") or
  questions. The prompt must treat those as affirmative, and LoCoMo is the
  wrong corpus for contradiction evaluation; BEAM is the designed-for one.
- **Cost is compatible with the weak-model discipline**: ~180--370
  deepseek-chat calls per conversation at temperature 0, no reader-grade
  model involved, and the regex pre-filter skips ~76% of records.

A second iteration turned the prototype into a layered worker
(`evals/omnimemeval/research/polarity/polarity-worker.py`, validated by
`evals/omnimemeval/research/polarity/polarity-validate.py` against per-message DeepSeek labels on BEAM conv 1,
188 messages ingested via `evals/omnimemeval/research/ablations/beam-ingest.mjs`). A spaCy rule layer (negation
via dependency `neg` on the ROOT verb, SVO backbone for the key, idioms and
"don't need/have" necessity-negations deferred) resolves 27% of records at
zero cost with 100% polarity agreement; the rest go to the LLM in batches of
15 (10 calls total vs 188 one-by-one) with the current key vocabulary in the
prompt, reaching 99.3% agreement. An `extract_method` column records which
layer filled each row. Two rule-layer lessons: in multi-clause sentences the
predicate must come from the clause that carries the negation (msg-58's ROOT
is "starting" but the fact is "never written"), and negations of
necessity/ability are guidance, not factual denials.

The canonicalisation blocker was then closed
(`docs/design/predicate-key-canonicalization.md`,
`evals/omnimemeval/research/polarity/polarity-canonicalize.py`): a strict key grammar on both
layers (strip aspectual/modal wrappers, bare head-noun objects), LLM
arbitration of embedding-similar key pairs (synonym merges like
`implement_route == write_route`), a `neutral` polarity for non-claims, and
a temporal join filter (earlier affirmation vs later negation, ordered by
`rowid`). The known BEAM pair now ranks first of 4 join candidates. The
surprise negative result: deepseek-chat's per-pair contradiction verdicts
are prompt-unstable (the same gold pair judged true and false under trivial
rephrasings), so weak-model verification is advisory only — precision must
come from upstream keying, not a downstream veto.

Record granularity was the remaining ceiling: BEAM conv 1's second official
contradiction lives inside one 4.7K-char message, invisible to a one-polarity-
per-record model. Moving extraction to claims (721 claims from 188 records)
made both official contradiction pairs detectable, and claim-level
arbitration confirmed 83 synonym merges. An answer-stage A/B probe
(`evals/omnimemeval/research/probes/beam-answer-probe.py`) then showed why this matters for
scores: an unprimed weak reader given raw evidence picks one side and misses
the contradiction (Q1 answered confidently wrong), while the same evidence
plus a metadata-derived contradiction note produces the official
`ideal_answer` behaviour. The render path now attaches those deterministic
notes in both the OmniMemEval adapter and Pi's resident, automatic-recall, and
`nmg_get` contexts. Pi's `nmg_remember` schema also accepts atomic claims, while
the core derives record-level polarity, predicate, confidence, and extraction
method from the first non-neutral claim rather than trusting a second,
independently supplied rollup. Contradiction lookup rejects records whose
shared scope keys disagree.

The expression shape must therefore follow the question type, and choosing
the shape is itself an unrouted decision today. MGR set logic remains a Lab
primitive.
