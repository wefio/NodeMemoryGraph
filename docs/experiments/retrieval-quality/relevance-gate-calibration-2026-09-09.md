# Relevance-gate calibration — historical samples and score-scale limits

[English](relevance-gate-calibration-2026-09-09.md) | [简体中文](relevance-gate-calibration-2026-09-09.zh-CN.md) · [Terms](relevance-gate-calibration-2026-09-09.terms.yaml)

**Scope.** Step 1 of the retrieval relevance gate
(`docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md`) implemented a
loose deterministic floor and then could not calibrate it. This note records the
problem, the standard explanations and mitigations in the information-retrieval
literature, and what they imply for the model gate (step 2).

## The observed problem

This is a historical synthesis/sequence of experiments, not current defaults,
new measurements or an enablement decision. External sources (papers, vendor
blogs, forums and tutorials) were not reverified. The
[current training owner](../../design/relevance-training.md) makes memory
benchmarks evaluation-only, unknown judgments non-negative, and runtime admission
separate. The legacy LoCoMo fitting below is not a current training recipe.
The 19/23 recalls and later 25-label corpus are different recorded checkpoints;
no independent-user count or complete cohort linkage is supplied. Noise/partial
are recall-level labels, not verified truth/falsehood for every candidate.

Calibration sweep over the labeled recall corpus (19 real recalls), where a
result is dropped below a recorded relevance floor (originally called bounded;
see the unresolved units below):

| floor | noise dropped | partial dropped | kept precision         |
| ----- | ------------- | --------------- | ---------------------- |
| 0.55  | 2             | 1               | ≈0.23                  |
| 0.70  | 8             | 2               | 0.22                   |
| 0.80  | 13            | 3               | 0.33 (16/19 abstained) |

No floor separates the classes: noise top1 spans 0.54–0.87 and partial 0.51–9.0,
interleaved at every level; within one recall the candidate scores are nearly
identical (`[0.77, 0.77, 0.77, 0.76]`). The displayed floors trade noise and partials; their unequal class denominators
do not establish equal error rates or absence of all first-stage signal.

## Possible causes and score-scale ambiguity

The bounded-score description conflicts with partial top1 = 9.00 and gap = 2.00
in the feature table. The 19-recall range also starts at 0.51 versus 0.55 in the
23-recall table. Preserve the values; their scale/path/cohort mapping is unresolved,
not a license to divide by ten or silently merge cohorts. Narrow bands alone do
not diagnose anisotropy or hubness. These are hypotheses, not local causal tests.
CV is invariant to positive multiplication, not arbitrary offsets/nonlinear
compression; boundedness alone does not force every query to cv ≈0.01.

- **Anisotropy compresses cosine scores.** Learned embedding spaces have a
  directional bias that squeezes cosine similarity into a narrow band; the raw
  score becomes hard to interpret and thresholds do not transfer. The observed score band alone does not establish this mechanism.
- **Hubness.** In the same anisotropic spaces, a few points sit falsely close to
  many queries — they surface regardless of the query and inflate the score band.
- **Bi-encoder scores are not comparable across queries.** Dual-encoder
  similarity is treated as an "opaque black box"; the same score means different
  things for different queries, so **a fixed global threshold is unreliable**.
  (NMG's `combinedScore` adds a second scale problem: raw BM25 on the degraded
  `fts5` path vs bounded hybrid score on the vector path — `qpp.ts` already
  documents this and switches to the bounded `hybridScore`.)

## What the literature does about it

1. **Rerank, then threshold.** A cross-encoder (or any stronger/second-stage
   scorer) jointly encodes query and candidate, producing much more
   discriminative scores; practitioners then threshold the reranker score rather
   than the first-stage score. Some vendors claim the reranker score has a useful
   calibration property enabling a fixed cutoff — treat that as a practical
   guideline, not a verified guarantee. This is the canonical answer to
   "the first-stage threshold does not work".
2. **Per-query normalization before thresholding.** Compute mean/σ over the
   candidate list and z-score the scores, so a threshold means "this many σ above
   this query's own average". It also **flags flat/uninformative lists** — exactly
   the near-identical-score case above. Roots in meta-search score-normalization
   work (CombSUM / z-score).
3. **Fix the embedding geometry.** Mean-centering / whitening / z-scoring the
   embeddings restores score interpretability and mitigates hubness.
4. **Selective classification / learning to reject.** Chow's rule and learned
   abstention functions trade risk against coverage: the system abstains on
   low-confidence items instead of forcing a prediction. (NMG's "abstain = inject
   nothing" is this.)
5. **Conformal abstention.** Thresholding rules wrapped in conformal prediction
   give a distribution-free coverage guarantee (≥ 1 − α), and dual-threshold
   variants adapt the abstention level. This is how to _choose_ the threshold
   with a target, rather than eyeballing a gap.
6. **Query performance prediction (QPP).** Estimate per-query quality from the
   score distribution to trigger adaptive retrieval. NMG already computes QPP
   components (`top1`, `topGap`, `nqc`, variance) — the dispersion signals
   (`topGap`, `nqc`) are precisely the "flat list = low confidence" detector.
7. **Observation-based calibration (heuristic).** For a first cut, run ~20
   queries, record scores, find the gap, set the threshold there — explicitly a
   starting heuristic, not a method.

## Implications for the model gate (step 2)

- The model gate must be a **reranker/verifier**, not a second first-stage
  score: it consumes features and outputs its **own** discriminative score, and
  the threshold lives on that score. Thresholding `combinedScore` again would
  repeat step 1.
- **Orthogonality is required** (the record's risk): a reranker that only rereads
  the embedding score is the anisotropy problem again. It needs features the
  first stage does not already encode.
- **Two cheap program-side wins are available now**, both deterministic and
  independent of the model: per-query normalization (z-score / margin over the
  candidate list) instead of a global floor, and using dispersion (`topGap`,
  `nqc`) as a "flat list ⇒ low confidence ⇒ abstain" signal. The corpus's noise
  recalls are exactly the flat ones.
- **Choose the AND threshold by conformal / selective-classification framing** on
  the labeled corpus, targeting a risk–coverage point, rather than a guessed gap.
- **Anisotropy post-processing** on the embedding side may be a cheaper
  standalone improvement, but it changes retrieval globally and is out of scope
  for the gate.

## Feature experiment: can any single program-side signal gate?

Recorded score-shape features over 23 labeled recalls (score units unresolved,
not established bounded relevance; `cv` = sd/mean, `gap` = top1−top2):

| label   | n   | top1 range  | sd range      | cv range        | gap range   |
| ------- | --- | ----------- | ------------- | --------------- | ----------- |
| noise   | 17  | 0.54 – 0.87 | 0.003 – 0.044 | 0.0032 – 0.0634 | 0.00 – 0.05 |
| partial | 6   | 0.55 – 9.00 | 0.003 – 0.943 | 0.0033 – 0.1230 | 0.01 – 2.00 |

Flat-list abstain sweep (`abstain when cv < t`):

| t     | abstained | of which noise | of which partial |
| ----- | --------- | -------------- | ---------------- |
| 0.003 | 0         | 0              | 0                |
| 0.004 | 4         | 3              | 1                |
| 0.005 | 5         | 4              | 1                |
| 0.006 | 8         | 6              | 2                |

Same verdict as the absolute floor: **every useful level removes noise and
partials together**, and kept precision is essentially unchanged (≈0.26). No
level is safely usable, which is why `NMG_RELEVANCE_MIN_Z` and
`NMG_RELEVANCE_MAX_CV` ship **off** — they are features and experimental knobs,
not defaults.

## Benchmark generalization check (LoCoMo, lexical)

The reported lexical path and gold-string labels differ from the small live
capture. A raw/bounded difference is a hypothesis, not an isolated cause across
those different datasets, queries and labels. Zero LongMemEval gold hits here
cannot establish dataset unanswerability or validate a gate on positive cases.

Does the calibration transfer? Re-ran the retrieval path directly against the
ingested benchmark store in lexical mode (no embedding service needed) and
computed the same shape features per question, labelling a question `hit` when
any retrieved candidate matches a gold (`evals/retrieval/` scoring direction).
LoCoMo: 1532 scored questions, 268 hit / 1264 miss.

| feature | hit (median) | miss (median) | miss p75  | separates?       |
| ------- | ------------ | ------------- | --------- | ---------------- |
| top1    | 26           | 23            | 30        | no — overlapping |
| cv      | 0.110        | **0.000**     | **0.024** | descriptive shift, not proven disjoint classes |
| gap     | 4            | 0             | 0         | partially        |

Flat-list abstain on `cv` (lexical), **candidate-level** definition: kept
precision = gold kept / all kept, hit-question recall = questions with ≥1 gold
kept / 268 questions that have a gold at all. Baseline is 272 gold of 4593
candidates (5.9%).

| abstain when cv < | abstained groups | kept | kept gold | kept precision | hit-question recall kept |
| ----------------- | ---------------- | ---- | --------- | -------------- | ------------------------ |
| 0.002 (default)   | 968              | 1692 | 221       | 0.131          | 81%                      |
| 0.027             | 1015             | 1551 | 210       | 0.135          | 77%                      |
| 0.109             | 1305             | 681  | 138       | 0.203          | 50%                      |

The then-labelled default is the loose 0.002 point: 5.9% → 13.1% precision and
81% hit-question retention. At `cv ≥ 0.109`, precision is 20.3% (about 1.55×
13.1%, not double), while hit retention drops to 50% (31 percentage points).
This is this raw-score harness comparison, not broad generalization. LongMemEval was
uninformative here (0 gold hits in lexical mode), so it gives no separation signal
either way.

**The generalization catch.** The benchmark and live capture differ in data,
queries, labels and score path. The record gives raw BM25 0–65 versus bounded
`hybridScore` near ~0.6 and cv near ~0.01 in the small capture. This motivates a
scale/transform hypothesis, not an isolated causal measurement. Positive scaling
alone leaves cv unchanged; offsets/nonlinear transforms can change it. The
observations do not prove every bounded score loses signal or only raw scores
can support a useful gate.

**Applied.** `src/core/relevance-gate.ts` therefore computes dispersion and the
relative floor on the raw scale (`rawRelevance`), keeping the bounded score only
for the portable absolute floor, and `tools/relevance-gate-calibration.ts`
reproduces the table above from the pinned store (`--dataset locomo`), so the
operating point can be re-checked without an embedding service or a live corpus.

## What step 2 therefore needs (historical hypotheses)

1. The tested single-feature cuts did not separate these samples. That does not
   prove a nonlinear combination is necessary or sufficient; linear and nonlinear
   alternatives need comparison.
2. Raw lexical/vector, exact-term/entity and structural features were proposed
   complements to top1/mean/sd/cv/gap/z. A bounded transform alone is not a causal
   diagnosis; normalization needs defined zero-variance/missing-value handling.
3. The 23 labels are insufficient for the general claims made here, not a universal
   minimum-size theorem. The old `recall-instance-judge --list` / `--set` loop was
   a collection proposal, not authority to invent negatives or retrain benchmarks.
4. Test signal complementarity; "orthogonality" is a modeling objective, not an
   established statistical independence or a substitute for verified evidence.
5. Risk/coverage targets and valid calibration are needed. Generic conformal
   coverage ≥1−alpha is not automatically a bound on kept-item noise, especially
   without exchangeability, the correct loss and independent data.

## Model gate (step 2) results

`src/lab/relevance-model.ts` (an MLP on the shared `autodiff.ts`) trained by
`tools/relevance-model-train.ts` on the same LoCoMo store, candidate-level gold
labels, split by QUESTION. This keeps one query's candidates together, but does not
prove no shared user/conversation, repeated document or semantic-query leakage:

| metric                 | value                                                      |
| ---------------------- | ---------------------------------------------------------- |
| held-out candidate AUC | 0.775 → **0.891**                                          |
| accuracy @0.5          | 0.954                                                      |
| gate floor 0.2         | kept precision **0.457** (baseline 0.053), hit recall 0.44 |
| gate floor 0.5         | kept precision 0.733, hit recall 0.23                      |

The model gate removes candidate noise far more sharply than any deterministic
threshold; ANDing it after the program gate is what makes the compound gate
strict while each half stays loose.

These are reported implementation observations for that configuration, not a
universal failure of standardization or proof that every zero-initialized tensor
network stays constant. Deterministic initialization is not independent repetition.
Two implementation findings worth keeping:

1. **Standardising the feature vector breaks training.** Normalising each feature
   magnifies narrow-range ones (`rel_ratio` z down to −6.9), saturating the hidden
   sigmoid; training collapses to the base-rate constant (AUC 0.500). Un-normalised
   on the already-bounded features it reaches 0.881–0.891. Normalisation is kept
   but is opt-in and off.
2. **`Tensor.matrix` starts at zeros**, which leaves the input layer with zero
   gradient (a bias-only constant model). A small deterministic random seed is
   required to break the symmetry; the synthetic check that hid this failed to
   reproduce it only by an accidental rank-1 path.

## Turning the gate on by default: what the literature prescribes

This records a rollout proposal, not a deployed model, unanimous survey or
current activation procedure. A learned score is not independent verification;
shadow/canary/default authority is separate. Do not choose 0.5 merely because it
is a default, but 0.5 is not intrinsically forbidden. Platt/isotonic/temperature
calibration and low ECE do not guarantee portability under domain shift; generic
conformal results require their sampling/loss assumptions. None of the steps
below authorizes new collection, training, traffic or an automatic default flip.

The remaining decision is whether to flip `NMG_RELEVANCE_GATE` /
`NMG_RELEVANCE_MODEL` on by default, and at which floor. The old note proposed a staged evaluation, not a mere config flip:

1. **Do not accept 0.5 solely because it is the default.** Pick the operating point from a curve (PR /
   risk–coverage) against a stated objective. For an injection gate the asymmetry
   is explicit: a false positive pushes noise into every consumer turn, a false
   negative withholds a memory that was available — so the objective is a
   precision target, and abstaining is the safe action under uncertainty.
2. **Calibrate before thresholding.** The MLP's sigmoid output is a score, not a
   calibrated probability. Post-hoc Platt / isotonic / temperature scaling
   (evaluate with Brier / ECE) is what makes a fixed floor meaningful.
3. **Set the floor with conformal risk control.** Rather than eyeballing a gap,
   bound an expected loss (e.g. the noise-injection or false-negative rate) at a
   chosen level; the guarantee is distribution-free. Adaptive / dual-threshold
   variants trade this against how often the model is consulted.
4. **Stage the rollout.** Offline evaluation → **shadow** (compute the decision,
   act on nothing) → **canary** (act on a fraction) → default, with rollback
   ready. NMG already has a shadow precedent (the controller shadow log).
5. **Guard against domain shift.** The historical experimental model is trained on LoCoMo; the
   live store and query mix are a different distribution, and a LoCoMo floor is
   therefore out of distribution. Either retrain on the live corpus once it has
   volume, or add an OOD / drift guard that abstains (falls back to the program
   gate) outside the training distribution, monitored with a changepoint detector
   (e.g. Page–Hinkley).
6. **Treat domain shift and subpopulation shift as the main failure modes** —
   monitor metrics correlated with failure, not just accuracy.

**Concrete recommendation.** Keep both gates off by default for now. Add a gate
**shadow log** (decide, log, do not act) and collect live decided-vs-labelled
pairs; calibrate the model on a held-out set; then choose the floor with
conformal risk control against a stated noise-injection bound; and only then flip
the default, canary first. Because the model is dataset-specific, tie the
enablement to either a live-corpus retrain or an OOD guard.

## Raising model recall: methods, and the real ceiling

The model's recorded conditional question retention is 55%; no chance test or
independent-repeat uncertainty is supplied here: candidate precision is 0.512
against a 5.9% base rate, and candidate AUC is 0.891. It is 55% of the gold that
the retriever actually surfaced. And that is the point:

| quantity                            | value                          |
| ----------------------------------- | ------------------------------ |
| questions (all have gold)           | 1532                           |
| questions whose gold is in the pool | 268 = 17.5% **(this harness)** |
| model keeps a gold                  | 147 = 55% of the pool          |

> **Correction.** The 17.5% above comes from _this_ harness — a direct
> `searchMemoryContext` on the store with a simple `normalizeText` containment
> gold match. It is **not** the product path and **understates** the ceiling. The
> recorded product-path number (`docs/experiments/retrieval-quality/hybrid-2026-08-16.md`,
> all 10 LoCoMo users, 1532 questions) is any@20 = **34.3% lexical / 40.5%
> hybrid** (R@20 24.1% → 29.3%). Treat 17.5% as a harness artefact, and read
> "the model reaches 55% of what is retrievable" against the harness pool only.

**The ceiling is the retriever, not the model.** Every arm here is the degraded
lexical path; the recorded hybrid gain is real but modest on LoCoMo (+5–6 pts of
R@20 / any@20) and large only on specific LongMemEval question types (preference
56.7% → 86.7%). Better embeddings raise the ceiling and add the semantic signal
these features lack (`vector` is 0 everywhere below), but they are not a step
change on LoCoMo, so they do not by themselves remove the noise problem the gate
exists for.

Model-side methods, in rough order of expected value:

1. **Query–candidate interaction features (cross-encoder style).** The current
   vector is mostly candidate-intrinsic; a reranker's power comes from joint
   query–document interaction (semantic similarity, BM25 components, entity/term
   match variants). This is the main modelling gap.
2. **Hard-negative mining + imbalance handling.** Train on semantically similar
   but wrong candidates (exactly the live noise) with a focal / weighted loss so
   the rare positives carry weight.
3. **Pairwise / listwise learning-to-rank loss** instead of pointwise BCE —
   ranking is relative. (Evidence that it beats pointwise BCE on _recall_ is thin,
   but the framing is standard.)
4. **Calibration** (Platt / isotonic / temperature) so a floor is portable, then
   re-measure the AND trade-off.
5. **More data / retrain on the target distribution** — the historical experimental model is
   LoCoMo-specific and OOD on the live store.
6. **Operating point** — a lower floor trades precision for recall; measure at a
   fixed recall target rather than tuning to 0.5.

**Order of work.** (a) restore embeddings → raises the pool ceiling and adds the
semantic feature; (b) add interaction features; (c) hard negatives + focal /
pairwise loss; (d) calibrate and re-measure the AND trade-off; only then decide
whether the model gate may join the default intersection.

## Model-side methods: measured effect

17-feature vector (adds query–candidate `jaccard`, local-IDF-weighted coverage,
and character coverage), losses, and Platt calibration, all trained/evaluated on
the LoCoMo store with a by-question train/val/test split:

| variant                         | test AUC | ECE   | floor 0.2 prec / hit-recall |
| ------------------------------- | -------- | ----- | --------------------------- |
| 14 features, BCE                | 0.891    | —     | 0.457 / 0.438               |
| 17 features (+interaction), BCE | 0.894    | 0.010 | 0.407 / 0.458               |
| + focal loss                    | 0.895    | 0.008 | 0.463 / 0.396               |
| + pairwise (RankNet)            | 0.896    | 0.008 | 0.486 / 0.375               |
| focal + pairwise                | 0.886    | 0.012 | 0.352 / 0.521               |

The table does not show "no recall movement": hit recall ranges from 0.375 to
0.521; the 0.521 point exceeds baseline 0.438 while precision falls from 0.457
to 0.352. AUC is near 0.89, not proof of equivalence. Different calibrated
models at floor 0.2 are not a matched-coverage comparison. ECE ≤0.012 is
reported without baseline ECE/uncertainty here, not proof of portable calibration.

The fixed pool is a limit, but it does not by itself explain these model differences: the retriever surfaces the gold for
only 17.5% of questions, and the model already reaches ~45–55% of that. A remove-only head cannot exceed that pool, but retaining ~45–55% still leaves
room within it; this is not proof that only retrieval can improve outcomes. Composition on gold questions (floor 0.5) is
`program 0.729 / learned 0.271 / AND 0.271 / OR 0.729` — the AND is bounded by the
learned half, and the OR adds essentially nothing over the program gate alone.

**So the lever is the retriever, not the model** — but the recorded magnitude
says the embedding fix alone does not settle the gate question. Hybrid is a
+5–6 pt move on LoCoMo, and the noise the gate addresses is a _precision_
problem, not a pool-recall one. Restoring embeddings is worth doing on its own
merits; it does not by itself decide whether the gate ships.

## Evidence and interpretation limits

The 268/1532 = 17.5% and 147/268 ≈55% are conditional question-level harness
counts, not item recall or an oracle bound on future retrievers. Product-path
34.3% lexical / 40.5% hybrid and +5–6 points belong to their recorded settings;
they do not cap future embedding improvements. The reported 0.954 accuracy is
class-imbalance-sensitive, not independent evidence of safety. Historical
recommendations to collect labels, fit models, normalize or enable shadow do not
replace the current training/data/privacy/activation owners. "Safe abstention"
can still withhold needed evidence; loss and coverage must be stated.

## Sources

- Dense retrieval / bi-encoder calibration: <https://mbrenndoerfer.com/writing/dense-retrieval-semantic-search-bi-encoders>,
  <https://oneuptime.com/blog/post/2026-01-30-dense-retrieval/view>
- Cross-encoder reranking: <https://mbrenndoerfer.com/writing/reranking-cross-encoders-information-retrieval>,
  <https://mixpeek.com/guides/cross-encoder-reranking>
- Per-query normalization / threshold calibration: <https://ciir.cs.umass.edu/pubfiles/ir-242.pdf>,
  <https://www.reddit.com/r/Rag/comments/1ojkisg/calibrating_reranker_thresholds_in_production_rag/>,
  <https://www.zudyog.com/learn/retrieval-threshold-calibration-rag>
- Anisotropy and hubness: <https://arxiv.org/html/2504.16318v4>,
  <https://www.emergentmind.com/topics/anisotropy-in-embedding-representations>
- Selective classification / learning to reject: <https://arxiv.org/html/2505.15008v2>
- Conformal abstention: <https://www.emergentmind.com/topics/conformal-abstention>,
  <https://arxiv.org/html/2502.07255v1>
- Query performance prediction from score distributions: <https://dl.acm.org/doi/10.1145/3762197>,
  <https://www.semanticscholar.org/paper/Predicting-Query-Performance-Directly-from-Score-Cummins/c1f5e71cbb621888418bea7aecd0eb188a2719eb>
- Retrieval abstention in RAG: <https://arxiv.org/html/2604.27283v1>,
  <https://tianpan.co/blog/2026/04/16/rag-retrieval-abstention-empty-corpus>
- Threshold selection / calibration: <https://scikit-learn.org/stable/modules/classification_threshold.html>,
  <https://scikit-learn.org/stable/modules/calibration.html>,
  <https://www.evidentlyai.com/classification-metrics/classification-threshold>
- Staged rollout (shadow / canary): <https://www.qwak.com/post/shadow-deployment-vs-canary-release-of-machine-learning-models>,
  <https://oneuptime.com/blog/post/2026-01-30-mlops-canary-model-deployment/view>
- Conformal risk control: <https://openreview.net/forum?id=33XGfHLtZg>,
  <https://arxiv.org/html/2512.12844v2>
- Domain shift / failure monitoring: <https://europe.naverlabs.com/blog/predicting-when-machine-learning-models-fail-in-production/>,
  <https://ascpt.onlinelibrary.wiley.com/doi/full/10.1111/cts.70349>
