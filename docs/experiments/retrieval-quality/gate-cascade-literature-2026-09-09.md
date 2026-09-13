# Literature scan: can two gates be cascaded, and is a gate ever "safe to switch on"?

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

1. **Cascading two _filters_ is provably the same decision as ANDing them.** The
   literature never treats the cascade as extra filtering power; it is a **cost**
   device (early exit, cheap → expensive) and a **joint-calibration** problem.
   "Cascade instead of AND" buys nothing by itself.
2. **A per-query "this list is mostly noise" signal has a name and a literature**:
   post-retrieval **query performance prediction (QPP)**. Our `cv` is essentially
   the classical **NQC** (normalized query commitment = dispersion of the top
   scores), and the standard uses of QPP are exactly the decisions we discussed —
   an adaptive cutoff, and "retrieve again / reformulate".
3. **No formulation makes enabling a filter "always positive".** What exists is
   **finite-sample risk control** (conformal / selective prediction) and, most
   directly, **joint calibration of a two-threshold cascade against a target risk**
   (BalanceRAG). That turns "should the learned gate ship?" into a _certification_
   question with explicit α and δ — falsifiable, and the right shape for our
   acceptance bar.

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
- Consequence for us: `applyRelevanceGates` (program gate → learned gate) is
  **already** a cascade, and because **both stages are pure filters it is
  identical to the AND** — staging and order do not change the resulting set. A
  cascade only becomes a different object if a stage **adds** (candidate
  expansion, query rewriting, larger k) or **changes the other stage's
  parameters** (threshold chaining).
- The one property the literature does assign to ordering: **an earlier stage's
  errors are unrecoverable** — a later stage never sees what an earlier one
  dropped. This matches our own measurement (the model recovered only 2 of 51
  program-gate false drops), and it is why the delete permission should sit in a
  single, last stage.
- Also standard: **every top-K cut creates a recall ceiling** (candidate-generation
  guidance), and reranking practice notes are explicit that
  _reorder-without-filtering_ is what "helps recall without hurting it" — a filter
  is a different animal from a reranker.
- Empirical ceilings in the literature match ours: realistic retrieval covers only
  **2–19% of relevant items at K=100** across three domains in an LLM-reranking
  study; our product-path lexical any@20 is 34.3% (hybrid 40.5%).

## Premise (b): "is this recall mostly noise?" — QPP and set-level gates

- **Post-retrieval QPP** predicts retrieval quality from the retrieved list's
  score distribution, with no relevance labels. The classical predictors include
  **NQC** (dispersion of the top scores — our `cv`), score-gap, and
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
  be compared against the classical predictors (NQC/`cv`, score-gap), which are
  strong and free.

## Premise (c): is there a "switch it on and it is good" formulation?

- **No.** In selective prediction (Chow 1970) and learning-to-defer (Mozannar &
  Sontag 2023; Narasimhan et al. 2022) the guarantee is **on risk at a chosen
  α**, not "always better"; and under a fixed budget any set-changing decision can
  drop a gold. The practice literature draws the same line we did: a **reranker**
  (reorders) preserves recall, a **filter** risks it.
- What the literature does offer, and we should copy:
  - **Risk control with finite-sample guarantees** on selected outputs
    (Angelopoulos et al.; conformal prediction). The variant matching our objective
    is **conformal sets with limited false positives** (Fisch et al., ICML 2022) —
    control the false-positive rate _in the kept set_.
  - **Conformal post-hoc filtering**: CiteGuard controls false-discovery rate on
    citation faithfulness. That is precisely "filter, but with a promised noise
    level".
  - **Cascaded risk control — the closest published shape to our two gates.**
    **BalanceRAG: Joint Risk Calibration for Cascaded Retrieval-Augmented
    Generation** (2026) governs a two-branch cascade (LLM-only → RAG → abstain)
    with **two thresholds**, calibrated **jointly rather than stage by stage**:
    each threshold pair is an operating point on a 2-D lattice, each is tested
    against the null "system risk > α", certified pairs get **FWER control at
    level δ** (so _any_ later choice from the certified set is valid), and the
    shipped pair is the **highest-acceptance certified one**. It extends to
    **multi-risk** (bound retrieval usage together with selection-conditioned
    error). Its explicit finding: **stage-wise calibration is valid but
    conservative** — joint calibration retains more accepted examples at the same
    risk.
  - Cheap-then-expensive **routing** with a Hoeffding upper-confidence shipping
    rule (UR-RAG, snippet-level source) — same family.

## What this implies for NMG (design-level; no results claimed)

1. **Do not expect power from "cascading".** Keep the gates ANDed (equivalently
   staged). Real gains can only come from (i) a stage that _adds_, (ii) **joint
   calibration**, or (iii) a better first stage.
2. **Make the deletion point singular and last.** Stage 1 (candidate generation:
   lexical + vector + chains + second pass) should only add; the deterministic gate
   is the only remover; the model gets **no delete permission** (reorder, re-score,
   or predict a threshold only). This is the recall-oriented-then-precision-oriented
   split, and it makes "who dropped the gold" attributable.
3. **Reframe "should we enable the learned gate" as a certification problem.** On a
   held-out set, treat (program threshold, model threshold) as a lattice, compute
   acceptance and accepted-error at each point, control FWER at δ (Bonferroni is a
   sufficient conservative version; BalanceRAG's sequential graphical testing is
   the tighter one), and ship the max-acceptance certified point for a stated risk
   α. **If no point certifies, the honest answer is that the gate cannot ship** —
   and we would know it without arguing about it.
4. **State a risk target, not just a metric.** We currently report "kept precision
   5.9% → 13.1% at 81% hit recall" with no target. The risk-control literature uses
   `risk / carefulness / coverage / alignment` (RC-RAG) or a controlled FPR/FDR.
   Pick α (e.g. noise in the kept set ≤ 25%) so a threshold is a _claim_.
5. **Close the remaining scale hole.** The fixed absolute score floor (`0.05`) is
   the only still-scale-coupled part of our gate. The literature's two scale-free
   alternatives are (i) **rank/proportion cutoffs** (the cascade mechanism) and
   (ii) **per-query score normalization / score-distribution modelling**
   (z-score/NQC; normal–exponential mixtures, Arampatzis et al. 2011, Manmatha et
   al.). Our move to raw-scale dispersion is a partial NQC; the absolute floor
   should probably be dropped or replaced by a rank-proportion cut.
6. **Expect the retriever to remain the dominant lever.** The literature's own
   recall-ceiling numbers match ours; no gate fixes a first stage that never
   surfaces the evidence.

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
  (tenant, date, permission) that is _true or false_ and independent of relevance.
  Ours is a **noisy score threshold**, so it removes true positives _and_ is only
  weakly correlated with the thing we want. That is the worst shape to put in
  series with a ranker, and our `AND = 0.12` is the size of the damage.

### 2. A learned predictor beating an unsupervised score-distribution rule has a documented reason

- **DuoQPP / _Unsupervised QPP for Neural Models_ (SIGIR 2023):** unsupervised QPP
  approaches are expected to _"yield limited effectiveness for neural ranking models
  because the retrieval scores of these models lie within a short range"_ — exactly the
  score-range compression that forced our own dispersion feature onto the raw scale.
  Supervised/adaptive QPP (e.g. ADG-QPP for dense retrievers) beats those baselines on
  Kendall τ and Spearman ρ.
- Consequence for us: "the learned half covers 0.68 where the cv rule covers 0.36" is
  the expected direction once labels are real, and the _reason_ is the same one we
  measured locally. Note also that QPP is evaluated by **correlation** (Kendall τ /
  Spearman ρ), not by AUC — a metric change we have not made yet.

### 3. With n = 60 the word "certified" is not defensible, and the standard for saying so is written down

- eDiscovery / TAR validation is the field that operationalises exactly this
  measurement, and its stated standard is blunt: a recall estimate is only as
  defensible as its sample, and _"a recall point estimate with a confidence interval
  so wide it proves nothing — 'recall is 80%, plus or minus 22 points' — is not a
  defensible result"_. There is explicitly **no one-size-fits-all sample size**: the
  sample must be justified for the interval being claimed.
- Applying that to our own output: the qrels run's split is **cal 60 / test 60
  questions**, so the "HOLDS at α = 0.70" line from that run is a **noise-level
  observation, not a certification**. The earlier bge run (307/307) is the smallest
  split we can currently defend, and even that flags the tight points at n ≈ 8.

### What this implies (unchanged design, changed composition)

1. **Keep the split, change the composition.** The evidence now points at _fusing_
   (learned convex combination of the program gate's score and the model's score,
   with the single weight fitted on a small held-out set) rather than intersecting
   two thresholds. It is also the cheaper thing to certify, because it has one
   parameter.
2. **Keep the program gate's purpose, not its position in series.** Its value was
   never "filter precision" — it was a deterministic, always-on floor. In a fusion it
   becomes a _feature_, which is compatible with never losing to the learned head.
3. **Do not quote the qrels run's certification line.** Report it as n = 60 and
   rebuild the sample before any claim; the TAR standard above is the bar to meet.
