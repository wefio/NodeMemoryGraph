# Retrieval relevance gate: two loose gates, ANDed into one strict gate

[中文](2026-09-09-retrieval-relevance-gate.zh-CN.md)

**Status:** implemented
**Approved:** unrecorded

## Problem

The disclosure path injects recalled memories with no absolute relevance floor.
A candidate only needs `combinedScore > 0` (`src/core/store/retrieval.ts`), and
`selectWithinActiveGraphBudget` (`src/core/store/active-graph.ts`) takes the top
N in rank order until the evidence target / budget is met, never comparing a
score against a minimum. QPP (`src/core/qpp.ts`) decides only whether to deepen
with a later pass, not what enters context.

Measured on 19 real recalls (auto + explicit, labeled through the
recall-instance corpus): precision 0.211 — 0 on_target, 4 partial, 15 noise.
Host automatic recall is the worst offender: 13 of 15 noise.

Relevance scores do not separate the two classes, so a score-only gate cannot
fix this:

- candidate top1 — noise 0.54–0.87 vs partial 0.51–9.0 (overlapping);
- within one recall the candidate scores are near-identical (for example
  `[0.77, 0.77, 0.77, 0.76]`) — no within-recall discrimination;
- `combinedScore` is path-inconsistent (raw BM25 on the degraded `fts5` path,
  bounded hybrid score on the vector path) — the same property `qpp.ts` already
  documents when it switches QPP to the bounded `hybridScore`.

These are the textbook signatures of an uncalibrated first-stage score
(anisotropy, hubness, cross-query incomparability). The literature on the problem
and its standard mitigations — rerank-then-threshold, per-query normalization,
selective classification / conformal abstention — is recorded in
`docs/experiments/retrieval-quality/relevance-gate-calibration-2026-09-09.md`.

## Decision

Two **loose** gates, ANDed. Each gate is deliberately loose — it removes only
what it is good at removing — and a candidate enters context only if it passes
**both**. A loose gate still rejects some noise; noise must therefore survive
two independent rejections, while a genuinely relevant candidate (accepted by
each loose gate) passes both. The compound gate is strict without either gate
having to be tight — which matters, because a single tight gate (or a single
evaluator) is exactly what discards useful context.

**Program gate (deterministic and cheap; strong at structure, score, exactness):**

- Runs on the deterministic signals — lexical match, embedding similarity, and
  structural/score features — normalized to one bounded, path-consistent score
  before comparison.
- Treat k as a maximum, not a target: return fewer — or zero — candidates.
- Drop only clearly-broken results (a loose floor), keep the existing strong-hit /
  margin early stop, and abstain when nothing clears the loose floor.

**Model gate (the learned neural model; strong at feedback-shaped relevance):**

- NMG's own neural model — the differentiable controller
  (`src/lab/differentiable-controller.ts` on top of `autodiff.ts`), trained from
  recall feedback and the recall-instance labels — scores each candidate as
  plausibly relevant or not at a **loose** bar. It is **not** an LLM judge and
  **not** the embedding model; embedding and lexical similarity belong to the
  program gate above.

**Composition:**

- Inject the intersection of the two gates; if the intersection is empty,
  abstain (inject nothing).
- Each gate operates where it is strong and stays loose there, so neither alone
  over-filters; the strictness is entirely in the AND.
- The learned gate runs only on candidates that already cleared the program
  gate, so the per-recall cost stays bounded. It is best-effort: on error the
  recall degrades to the program gate alone and never blocks. With no trained
  model available the path is deterministic.

**Asymmetry:** automatic (unprompted) injection can raise either gate, because
injected noise costs the consumer model every turn, not only the turn it asked.

### Model-gate enablement bar

- Auto-injection precision on the labeled corpus improves materially with no
  on_target lost (the noise band stops entering context) — the effect must come
  from the AND, not from either gate alone being tightened.
- Neither gate alone over-filters: each stays loose, and a relevant candidate
  still clears both.
- Abstain is representable: an empty intersection injects nothing.
- With no trained model available the recall path is fully deterministic and
  gated by the program gate alone.
- Recall is never blocked: a learned-gate failure degrades to the program gate.

## Alternatives considered

- **Score-only program threshold.** Rejected: the classes overlap and the scores
  carry no within-recall signal (see Problem), so any threshold either keeps the
  noise or discards the partial hits. A score-only gate also cannot be the strict
  gate, which is why the strictness lives in the AND of two loose gates.
- **Loose program gate + strict model gate.** Rejected in favour of two loose
  gates: a strict single gate (or a strict evaluator) is the known failure mode
  that discards useful context; ANDing two loose gates is strict against noise
  while leaving each gate cheap and forgiving.
- **An LLM relevance critic (Self-RAG `IsRel` / CRAG evaluator).** Considered and
  not adopted: the model gate is NMG's own learned neural model trained from
  feedback, not a prompted LLM. The Self-RAG / CRAG literature still grounds the
  loose-plus-AND shape, but the implementation is a learned classifier, so it
  stays deterministic at inference and improves with the feedback loop.
- **Model-only gate on every recall.** Rejected: per-turn latency and cost, and
  it loses the deterministic single-search path the retrieval design depends on.
- **Status quo (rank-only injection).** Rejected: measured precision 0.211; a
  store dominated by similar project-state memories guarantees a steady noise
  stream.

## Consequences

Shipping the program gate changes recall's default behaviour: a recall may now
return fewer — or zero — results, by construction. The items below are
consequences to watch, not blockers.

- **Correlated gates.** If both gates key on the same signal (for example the
  learned gate just re-reads the embedding score the program gate already used),
  the AND buys nothing. The gates must stay orthogonal — deterministic
  lexical/embedding/structural signals versus a feedback-learned model.
- Threshold calibration needs volume; 19 labels give an initial conservative
  value only, and the gates must roll forward as labels accumulate.
- **The learned gate needs training data.** Until the recall-instance labels are
  plentiful it is under-trained; a loosely-gated, under-trained model can still
  discard useful context. Looseness is the mitigation, not a guarantee.
- The learned gate adds inference cost on every recall whose candidates clear the
  program gate.
- The store's homogeneity is a data problem the gate suppresses rather than
  fixes.

## Implementation status

**Program gate — ON by default, no env switch.** `src/core/relevance-gate.ts` +
`src/core/store/retrieval.ts`; code constants `DEFAULT_RELEVANCE_FLOOR = 0.05`
(≈ BM25 0.53 on the lexical path — a genuinely loose cut; 0.4 would have meant
BM25 ≈ 6.7, which a test run showed is a hard filter, not a loose one) and
`DEFAULT_RELEVANCE_MAX_CV = 0.002`, the flatness abstain, applied only when the
list has at least `MIN_CV_COUNT = 4` candidates (dispersion is not estimable
below that, and the rule was calibrated on full k≈20 lists). It is deterministic and only ever removes
candidates, so it cannot add error; the LoCoMo regression
(`tools/relevance-gate-calibration.ts`) shows the flat-list rule keeps **81%** of
hit questions (217/268) while lifting kept precision 5.9% → 13.1% and keeping 36.8%
of candidates. A gate that has to be
switched on is a gate that never runs, which is why there is no
`NMG_RELEVANCE_GATE`.

**Model gate — opt-in by producing a model.** `src/core/relevance-features.ts` +
`src/core/learned-gate.ts` + `src/lab/relevance-model.ts`, trained by
`tools/relevance-model-train.ts`; enabled by placing a validated model at
`<dataDir>/relevance-model.json` (no env switch), ANDed after the program gate.
LoCoMo held-out: AUC ≈0.89, ECE ≤0.012 (Platt-calibrated). It is **not**
default-on because the AND caps gold recall at the learned half — on gold
questions `program 0.729 / learned 0.271 / AND 0.271 / OR 0.729` — and because
the shipped model is LoCoMo-specific (out of distribution on the live store).

**The enablement bar is a procedure, not a number.**
`tools/relevance-model-train.ts --certify` treats (set-level cut, model floor) as a
lattice, tests each pair against a target selection-conditioned risk α with a
finite-sample bound (Bonferroni over the lattice), and reports the chosen pair on a
held-out split. Enable a pair only when it certifies **and holds on test**. On the
current data (LoCoMo, 307 calibration questions) **nothing certifies below α = 0.60**,
and the pairs that do certify at 0.6–0.7 have test risks of 41–53% — worse than the
shipped program gate. The reason is the pool, not the threshold: only 15.6% of
questions have a gold anywhere in the pool, so the achievable risk at 10%
acceptance is ~34%. Measured in
`docs/experiments/retrieval-quality/gate-certification-2026-09-09.md`; the design
rationale is in
`docs/experiments/retrieval-quality/gate-cascade-literature-2026-09-09.md`
(joint threshold calibration under a risk bound, BalanceRAG).

**Feature blocks, and why the absolute-score block is optional.** The candidate
feature vector is split into `core` (textual overlap, rank/relative position, QPP,
record metadata) and `retrieval` (the three _absolute_ retriever scores: `raw_log`,
`bounded`, `vector`). Only `retrieval` is scale-bound: an absolute score scale is
not comparable across embedders, and using a head trained on one scale with another
fails **silently** (the numbers still look plausible while the threshold stops
separating anything). So a head declares the columns it reads, its blocks, and the
embedder identity (`EmbeddingClient.indexId`) its scores came from; the loader
refuses a head whose identity is not the runtime's, and a `core`-only head — which
cannot read the scale-bound block at all — loads anywhere. Training the
scale-bound block requires naming the embedder (`--embeddings --embedder <indexId>`),
so a mismatched head cannot be produced by accident either.

Measured on the current (lexical) store: the `core`-only head certifies a **better**
item-level point at α = 0.60 than `core+retrieval` (calibrated 29.7% vs 36.7% risk,
same procedure), so making that block optional is the better default as well as the
safer one. Both still drop on the held-out split.

**Model-side methods measured (no material recall gain).** Interaction features
(jaccard / IDF-weighted coverage / character coverage), focal loss, pairwise
RankNet with hard-negative mining, and Platt calibration were all tried:
AUC stays in 0.886–0.896 across variants; only calibration moved (ECE →
≤0.012). See the experiment note.

**Embedding path: optional, and lexical-only is the first-class path.** Embeddings
are a bonus, not a dependency: the core block is always available, a core-only head
needs no embedder at all, and the scale-bound block is included only when the
embedder is named. Deployment embeds with Gemini (rate-limited) while a local `bge`
venv can fill the persisted embedding index offline, so at query time only the query
needs one embedding call. The recorded lexical-vs-hybrid comparison
(`docs/experiments/retrieval-quality/hybrid-2026-08-16.md`, all 10 LoCoMo users)
is lexical any@20 34.3% → hybrid 40.5% (R@20 24.1% → 29.3%) — real but modest on
LoCoMo, large only on specific LongMemEval question types (preference
56.7% → 86.7%).

**Correction.** An earlier note in the experiment record called 17.5% the pool
ceiling; that came from a one-off harness (direct store search, stricter gold
match), not the product path, and understates it. The product-path number is the
34.3% / 40.5% above.

**Deferred:** the model gate's acceptance run, labelled volume, and a second
benchmark.
