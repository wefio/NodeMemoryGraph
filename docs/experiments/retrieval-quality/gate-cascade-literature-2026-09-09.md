# Literature scan: can two gates be cascaded, and is a gate ever "safe to switch on"?

[English](gate-cascade-literature-2026-09-09.md) | [简体中文](gate-cascade-literature-2026-09-09.zh-CN.md) · [Terms](gate-cascade-literature-2026-09-09.terms.yaml)

**Date:** 2026-09-09
**Status:** external-literature synthesis (web search); not a formal survey.
**Purpose:** test three premises that came up while implementing the retrieval
relevance gate (`docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md`):
(a) does **cascading** the two gates add power over ANDing them; (b) can a
per-query / set-level "this recall is mostly noise" signal be learned; (c) is
there a formulation in which **enabling** the learned gate is guaranteed
non-harmful.
**Scope:** cascade ranking, query performance prediction, selective prediction and
risk control, adaptive retrieval gating. English academic focus.

## Headline

This selected scan and its 2026-09-12 follow-up are historical, not an exhaustive
survey or new source verification. External statements below are the recorded
accounts of selected authors, not universal literature results. The
[current training protocol](../../design/relevance-training.md) owns admissible
labels and deployment boundaries; this report enables nothing.

1. Fixed item predicates over the same frozen pool satisfy B(A(S)) = A(S) ∩ B(S).
   "Pure filter" alone is insufficient: set-relative normalization, top-K,
   adaptive thresholds and shared budgets can make order change membership.
   Staging can affect cost without changing membership under those assumptions.
2. QPP is a relevant signal family. cv and NQC are related dispersion measures,
   not automatically identical formulas/normalizations. Learned QPP needs labels;
   inference need not see gold. Classical baselines are not zero-CPU-cost.
3. Conditional risk control is not "always positive" enablement. BalanceRAG is
   one selected motivation for joint calibration, not the only possible method,
   an unconditional guarantee or authority to ship.

## Premise (a): cascade vs AND

- A cascade is a sequence of filter+ranker stages ordered by increasing cost:
  stage 1 recall-oriented, last stage precision-oriented. The classic mechanism is
  a **rank-based cutoff that removes a fixed proportion of the input at each
  stage** (Wang, Lin & Metzler, SIGIR 2011) — the cascade prunes by _proportion_,
  not by a score threshold.
- **Joint (end-to-end) training of a cascade beats stage-wise/greedy training**,
  and the objective that matters for a cascade is **cascade recall** (Gallagher et
  al.; _Learning Cascade Ranking as One Network_, ICML 2025, uses recall-aware
  surrogate losses). Feature costs belong inside the cascade (Chen et al., SIGIR
  2017).
- The historical `applyRelevanceGates` description is program → learned.
  AND equivalence needs fixed predicates, not merely pure functions. Expansion,
  rewriting, larger k, threshold chaining or set-dependent filters can change it;
  arbitrary implementations are not proved order-independent.
- One property of remove-only stage ordering: **an earlier stage's
  errors are unrecoverable** — a later stage never sees what an earlier one
  dropped. The 2 of 51 program false drops is a model-alone counterfactual comparison,
  not actual recovery of candidates removed earlier, and it is why the delete permission should sit in a
  single, last stage.
- Also standard: **every top-K cut creates a recall ceiling** (candidate-generation
  guidance), and reranking practice notes are explicit that
  reorder-only preserves full-pool membership, not necessarily R@K or a
  budget-selected prefix. Reranking can change recall at the consumer cutoff.
- These cited coverage values have different k, domains and units; they are not
  quantitative corroboration of each other: realistic retrieval covers only
  **2–19% of relevant items at K=100** across three domains in an LLM-reranking
  study; our product-path lexical any@20 is 34.3% (hybrid 40.5%).

## Premise (b): "is this recall mostly noise?" — QPP and set-level gates

- **Classical unsupervised post-retrieval QPP** estimates retrieval quality from the retrieved list's
  score distribution, with no relevance labels. The classical predictors include
  **NQC** (top-score dispersion related to, not necessarily identical to, `cv`), score-gap, and
  top-score/clarity-style statistics. Foundations: ECIR 2024 QPP tutorial, QPP++
  2025 workshop.
- The standard downstream uses are the two we identified: **adaptive cutoff** (how
  much to keep) and **"retrieve again / reformulate"**. Recent work applies
  post-retrieval QPP inside agentic RAG and finds the QPP estimate for a generated
  query correlates positively with final answer quality (Tian et al., 2025) — i.e.
  a _set-level_ signal, not a per-candidate one, and it is used to decide a
  _process_ action.
- The complementary "should we retrieve at all" gate is its own family — **Self-RAG**,
  **Adaptive-RAG**, **SKR**, training-free **TARG** — and every member decides at
  the **query** level, which is the level at which "is this recall mostly noise?"
  actually lives.
- ⇒ For our set-level question the right shape is **a QPP-style predictor driving
  the cutoff**, not a second candidate filter. Critically, any learned version must
  be compared against the classical predictors (NQC/`cv`, score-gap), which do not require an extra model API call, but are not free computation
  or guaranteed winners.

## Premise (c): is there a "switch it on and it is good" formulation?

- **No.** In selective prediction (Chow 1970) and learning-to-defer (Mozannar &
  Sontag 2023; Narasimhan et al. 2022) the guarantee is **on risk at a chosen
  α**, not "always better"; and under a fixed budget any set-changing decision can
  drop a gold. The practice literature draws the same line we did: a **reranker**
  (reorders) preserves full-pool membership, not necessarily recall after a top-K
  or budget cap; a **filter** can remove members before that cap.
- What the literature does offer, and we should copy:
  - **Risk control with finite-sample guarantees** on selected outputs
    (Angelopoulos et al.; conformal prediction). The variant matching our objective
    is **conformal sets with limited false positives** (Fisch et al., ICML 2022) —
    control a specified false-positive loss; its exact denominator must be checked
    before equating it with FPR, FDR or aggregate kept noise.
  - **Conformal post-hoc filtering**: CiteGuard controls false-discovery rate on
    citation faithfulness. That is precisely "filter, but with a promised noise
    level".
  - **Cascaded risk control — the closest published shape to our two gates.**
    **BalanceRAG: Joint Risk Calibration for Cascaded Retrieval-Augmented
    Generation** (2026) governs a two-branch cascade (LLM-only → RAG → abstain)
    with **two thresholds**, calibrated **jointly rather than stage by stage**:
    each threshold pair is an operating point on a 2-D lattice, each is tested
    against the null "system risk > α", certified pairs get **FWER control at
    level δ** (so later selection is valid within that tested family and the paper's assumptions), and the
    shipped pair is the **highest-acceptance certified one**. It extends to
    **multi-risk** (bound retrieval usage together with selection-conditioned
    error). Its explicit finding: **stage-wise calibration is valid but
    conservative** — joint calibration retains more accepted examples at the same
    risk.
  - Cheap-then-expensive **routing** with a Hoeffding upper-confidence shipping
    rule (UR-RAG, snippet-level source) — same family.

## What this implies for NMG (historical proposals, no default change)

1. Fixed-predicate staging adds no filtering power by itself. Expansion, joint
   calibration and better signals were proposed levers, not an exhaustive list.
2. The singular last removal point concerns heuristic candidate suppression,
   not persistent-memory deletion. Permission/privacy/currentness filters remain
   mandatory and cannot be replaced by score fusion or learned features.
3. Compare a valid candidate family against stated alpha/delta with valid sampling
   assumptions. A certified maximum-acceptance point still needs deployment
   approval; no passing point is reason to withhold that proposal, not a theorem
   that no gate can work. FPR, expected FDR and aggregate kept-noise share are
   distinct losses/denominators, not interchangeable guarantees.
4. The motivating numbers remain 5.9% → 13.1% kept precision at 81% hit recall;
   kept noise ≤25% was a proposed target, not a validated runtime guarantee.
5. The absolute 0.05 floor was suspected scale coupling. Rank/proportion cuts,
   z-score/NQC and score-distribution models were alternatives, not proved safe
   replacements; raw dispersion itself is not automatically scale-invariant.
6. A fixed-pool remover cannot recover absent evidence. The 2–19% at K=100 and
   local lexical/hybrid any@20 34.3%/40.5% are different measurements.

## Open questions this scan does not settle

- Whether a **learned** set-level QPP predictor beats the classical ones
  (NQC/`cv`, score-gap) at equal hit recall. Cheap to test on the cached LoCoMo
  groups; the literature suggests classical predictors are strong baselines.
  **Answered (2026-09-09):** on LoCoMo the product's QPP score and raw-scale `cv`
  produce the _same_ iso-acceptance frontier, and under certification no point
  clears α ≤ 0.5 — see
  `docs/experiments/retrieval-quality/gate-certification-2026-09-09.md`.
- Whether our labelled volume can **certify** any model threshold at a useful α
  (≈270 gold candidates in the cached LoCoMo pool — likely too thin for anything
  but a very loose α). **Answered:** nothing certifies below α = 0.60, and the two
  pairs that do certify at 0.6/0.7 fail to hold on the test split.
- Whether a second _adding_ stage (query rewriting / expand-then-narrow) earns its
  latency on the live corpus.

## Selected sources

- Wang, Lin, Metzler, _A cascade ranking model for efficient ranked retrieval_,
  SIGIR 2011 — rank-based proportion cutoffs; recall-oriented stage 1.
- Gallagher et al., _Joint Optimization of Cascade Ranking Models_, WSDM 2019;
  Wang et al., _Learning Cascade Ranking as One Network_, ICML 2025 — recall-aware
  surrogate losses.
- Chen et al., _Efficient Cost-Aware Cascade Ranking in Multi-Stage Retrieval_,
  SIGIR 2017 — feature costs inside the cascade.
- Google ML, _Candidate Generation in Search_ — "every top-K cut creates a recall
  ceiling".
- _Why LLM Recommendation Reranking Fails in Practice_ — retrieval covers 2–19% of
  relevant items at K=100.
- Tian et al., _Am I on the Right Track? What Can Predicted Query Performance Tell
  Us about the Search Behaviour of Agentic RAG_, 2025 (arXiv 2507.10411) — QPP vs
  answer quality.
- QPP foundations: ECIR 2024 tutorial (Arabzadeh et al.); QPP++ 2025 workshop;
  RAG-QPP (2025).
- Asai et al., _Self-RAG_, ICLR 2024; _Adaptive-RAG_, NAACL 2024; TARG, _Retrieval
  as a Decision_ (OpenReview, training-free gating).
- Chow 1970; Mozannar & Sontag, _Who Should Predict?_, AISTATS 2023; Narasimhan et
  al., _Post-hoc estimators for learning to defer_, NeurIPS 2022.
- Fisch et al., _Conformal Prediction Sets with Limited False Positives_, ICML 2022.
- _Controlling Risk of RAG_ (RC-RAG, arXiv 2409.16146) — abstention metrics
  risk/carefulness/alignment/coverage.
- _C-RAG: Certified Generation Risks for RAG_; _CiteGuard: Conformal
  False-Discovery Control_; _AdaCP_ (Findings-EMNLP 2024).
- **BalanceRAG: Joint Risk Calibration for Cascaded Retrieval-Augmented
  Generation** (arXiv 2605.20084) — two-threshold cascade, joint calibration over a
  lattice, FWER control, max-acceptance certified pair, multi-risk.
- UR-RAG, _Unified Risk Calibration for RAG_ — Hoeffding upper-confidence shipping
  rule over a cheap-then-expensive cascade (snippet-level source).
- Score distributions/normalization: Arampatzis et al., _Modeling score
  distributions in IR_ (2011); Manmatha et al., _A formal approach to score
  normalization for meta-search_.

## Follow-up scan (2026-09-12): three measured findings, checked against the literature

This switches from LoCoMo to NFCorpus, not another arm of one dataset. A later
label audit found unjudged candidates had been assumed negative. These are
historical proxy outputs, not verified noise labels or currently admitted
training. AUC 0.89 → 0.72 spans changed datasets/labels/settings, not an isolated
causal effect of correcting labels. Literature analogies do not isolate causes.

Measured on the first qrels-labelled training set (NFCorpus, 3633 docs / 323 judged
queries -> 298 groups): the learned head covers **0.68** of gold questions where the
deterministic lexical gate covers **0.36**; the **AND of the two is 0.12** — worse than
either — and the union is 0.92. Replacing "candidate contains the gold answer string"
labels with real per-document relevance judgments moved test AUC from **0.89 to 0.72**.

### 1. Intersecting a hard deterministic rule with a better learned ranker is the failure mode the fusion literature exists to avoid

- **Bruch, Gai & Ingber, _An Analysis of Fusion Functions for Hybrid Retrieval_
  (TOIS 2023, arXiv 2210.11934).** Lexical and semantic signals are combined, and the
  paper's finding is that a **learned convex combination (score fusion) beats
  Reciprocal Rank Fusion** both in-domain and out-of-domain, that RRF is
  parameter-sensitive, and — the part that matters here — that the convex
  combination is **sample efficient: "requiring only a small set of training examples
  to tune its only parameter"**. So the literature's answer to "how do I combine two
  signals" is _fuse the scores_, and the fusion weight is cheap to learn.
- **Intersection is not a fusion function.** Rank-fusion surveys treat late fusion
  (score averaging, RRF) and early/intermediate fusion as the vocabulary; a hard
  constraint is a separate thing, and its cost is documented in the filtered-ANN
  literature: _"Pre-filtering restricts search to points matching the filter... Result:
  lower recall or higher latency from oversearching"_, and metadata filtering is
  described as _"the recall win nobody measures"_.
- **Why our case is worse than theirs.** Their filter is an exact metadata predicate
  (tenant, date, permission) that is _true or false_ and mandatory regardless of relevance; statistical independence is not assumed.
  Ours is a **noisy score threshold**, so it removes true positives _and_ is only
  weakly correlated with the thing we want. The `AND = 0.12` is a recorded proxy operating point in that cohort, not a
  universal worst shape or a measured production-harm rate.

### 2. A learned predictor beating an unsupervised score-distribution rule has a documented reason

- **DuoQPP / _Unsupervised QPP for Neural Models_ (SIGIR 2023):** unsupervised QPP
  approaches are expected to _"yield limited effectiveness for neural ranking models
  because the retrieval scores of these models lie within a short range"_ — exactly the
  score-range compression that forced our own dispersion feature onto the raw scale.
  Supervised/adaptive QPP (e.g. ADG-QPP for dense retrievers) beats those baselines on
  Kendall τ and Spearman ρ.
- Consequence for us: "the learned half covers 0.68 where the cv rule covers 0.36" is
  the expected direction once labels are real, and a common causal explanation has not been isolated by these comparisons. Note also that QPP is evaluated by **correlation** (Kendall τ /
  Spearman ρ), not by AUC — a metric change we have not made yet.

### 3. Sample adequacy depends on the claimed bound

- eDiscovery / TAR validation is the field that operationalises exactly this
  measurement, and its stated standard is blunt: a recall estimate is only as
  defensible as its sample, and _"a recall point estimate with a confidence interval
  so wide it proves nothing — 'recall is 80%, plus or minus 22 points' — is not a
  defensible result"_. There is explicitly **no one-size-fits-all sample size**: the
  sample must be justified for the interval being claimed.
- Applying that to our own output: the qrels run's split is **cal 60 / test 60
  questions**. "HOLDS at α = 0.70" is a reported tool outcome, insufficient here
  for a population claim. n=60 alone does not preclude every valid certificate,
  nor does 307/307 establish a universal minimum; the bge run also has operating
  points near n ≈ 8. Sampling, labels and the actual bound need joint assessment.

### What this implies (composition hypotheses, not default authority)

1. Convex fusion is a candidate comparison, not proof of lower risk or cheaper
   certification merely because it has one weight. Freeze the choice before
   independent testing; tuning data is not untouched test data.
2. Turning a heuristic score into a feature does not guarantee never losing to
   the learned head. Hard authorization/validity constraints remain hard.
3. Report n = 60 and label/uncertainty limits, not a new certification. The earlier
   no-point-below-alpha-0.60 answer refers to the question run; item calibration
   passes have different semantics and failed rechecks. See the certification note.
