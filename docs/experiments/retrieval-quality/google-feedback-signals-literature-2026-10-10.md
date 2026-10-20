# Literature review: how Google search and recommendation infer usefulness from weak behaviour signals

[English](google-feedback-signals-literature-2026-10-10.md) | [简体中文](google-feedback-signals-literature-2026-10-10.zh-CN.md) · [Terms](google-feedback-signals-literature-2026-10-10.terms.yaml)

**Date:** 2026-10-10
**Status:** external literature review (source reading); **not** an approved design, and not a statement of Google's current production behaviour.
**Purpose:** answer the user's question — absent per-item explicit ratings, on what basis do search and recommendation systems judge that an impression was useful, which of those practices transfer to NMG's active and automatic recall, and which do not.
**Scope:** Google Research / Search / YouTube primary sources first; generic debiasing literature marked "external general". Each entry records only what was actually read; entries without full-text reading stay at what the abstract supports.

## Summary (what must not be concluded first)

1. **"Not selected" is not a negative label.** Google's good-abandonment research states explicitly that treating query abandonment uniformly as a negative signal is wrong. NMG's "injected but not read" cannot be a negative example either.
2. **"Clicked" is not a positive label.** The ULTR line of work shows clicks are confounded by position and exposure bias; KDD'23 goes further: a model that lifts clicks may simultaneously **reduce the number of users who click at all** (clickbait and bias amplification).
3. Large-scale logs, overlapping exposure across policies and an A/B platform are preconditions for several methods. Whether NMG has enough data must be checked item by item. SIGIR'16 and WSDM'18 note personal-search feedback is sparse, so large-traffic methods cannot be assumed to work on a small corpus.
4. YouTube'16's impression-frequency feature can inspire repeated-impression work, but it is neither the only transferable mechanism nor a proven benefit for NMG. Not reading does not become a negative automatically; real impression, already-in-context, summary sufficient and budget stop must be distinguished.
5. **Long-term and short-term utility diverge** (KDD'15, RecSys'24), but measuring long-term utility needs A/B or constrained-optimization infrastructure that NMG lacks. NMG **cannot claim it can measure "long-term usefulness"**.
6. **What transfers is the shape, not the mechanism; mapping and proposals are in §9.**

---

## 1. Estimating "this impression satisfied the need" without explicit ratings

### 1. Good Abandonment in Mobile and PC Internet Search (SIGIR 2009, Google)
- Source: `https://research.google/pubs/good-abandonment-in-mobile-and-pc-internet-search/` (abstract read in full)
- Definition: **good abandonment** = the user abandons the query but the information need **was already satisfied by the results page**, with no click or reformulation needed.
- Findings: (a) suspected good abandonment is a **significant share** of all abandoned queries; (b) mobile is clearly higher than PC; (c) by need type, the dominant categories **vary widely** with locale and modality.
- Source conclusion: *"it is a mistake to uniformly consider query abandonment as a negative signal"*, and good abandonment can be **actively increased** by improving snippets and features.
- **Transferable to NMG:** the recall head (summary level) may already satisfy the need; "did not `nmg_get`" must be treated as **unknown**, not a poor rating.
- **Not transferable:** the paper gives prevalence and taxonomy only, not a usable rule for deciding good abandonment per item.

### 2. Incorporating Clicks, Attention and Satisfaction (CAS model, CIKM 2016, Google Research Europe + UvA)
- Source: `https://arxiv.org/html/1609.00552v1` (body read, including Sections 3–7)
- Model: jointly models **clicks, attention (mouse dwell → examination) and satisfaction**: `P(S=1) = σ(τ0 + Σ_k P(E_k=1)·u_d(D_k) + Σ_k P(C_k=1)·u_r(R_k))`.
- Key distinction: **D_k = whether the SERP item itself answers the question** (summary-level utility); **R_k = whether the full text behind a click answers it** (document-level utility). Under human annotation their Pearson correlation is only **0.085** and Spearman **0.094** — **summary-level usefulness ≠ document-level usefulness**.
- Metric: `U = Σ_k ε(φ_k)·(u_d(D_k) + α(R_k)·u_r(R_k))`, adaptable to non-linear layouts and closer to **self-reported satisfaction** than traditional metrics.
- Data scale (an important limit): **12 participants / 2334 sessions / only 243 with satisfaction feedback**; the survey appeared in **50% of sessions**, at most 10 times per person per day, with 1-hour and 24-hour mute buttons.
- Authors' own limits: far less data than typical click-model datasets, mostly CS-background users, skewed query distribution.
- **Transferable to NMG:** (a) separating "head information is enough" from "the body must be read" matches NMG's `header`/`exact` two levels; (b) satisfaction can be sampled **infrequently, mutably and on random sessions** instead of asking every turn.
- **Transfer limits:** NMG has no mouse-dwell observation; whether 243 satisfaction rows are trainable depends on model, objective and distribution, so the paper cannot give NMG a universal sample floor, and a user survey is not part of this round.

---

## 2. Bias in click and read signals, and debiasing

### 3. Learning to Rank with Selection Bias in Personal Search (SIGIR 2016, Google)
- Source: `https://research.google/pubs/learning-to-rank-with-selection-bias-in-personal-search/` (abstract)
- Problem: traditional click models need many clicks per query-document pair; personal search is personalized in corpus and need, so clicks are **highly sparse** and the approach does not transfer directly.
- Approach: poses the **selection bias** problem inside a learning-to-rank framework, including a **query-dependent** bias estimate that borrows similar queries to relieve sparsity; large online gains in "one of the world's largest personal search engines".
- **Transferable to NMG:** sparse clicks must be aggregated **across similar queries and items**; a single memory cannot be required to have enough feedback.

### 4. Position Bias Estimation for Unbiased Learning to Rank in Personal Search (WSDM 2018, Google)
- Source: `https://storage.googleapis.com/gweb-research2023-media/pubtools/4120.pdf` (first 200 lines of the PDF, including abstract and introduction)
- Findings: (a) result randomization (RandTopN/RandPair) **harms the search experience** and is **not acceptable** in personal search; (b) a regression-style EM over a position-bias click model estimates bias from **ordinary clicks** and handles **highly sparse** clicks; (c) the extracted bias clearly improves LTR, and **pairwise models exploit it better than pointwise models**.
- **Transferable to NMG:** do not perturb the order a user sees in order to learn ("non-intrusive" is an explicit design constraint); relative preference is more reliable than absolute judgement.
- **Transfer limits:** EM needs enough data to estimate bias parameters; the paper gives no small-sample floor for NMG's setting, so it cannot be declared infeasible outright, nor can its results be read as proof of benefit on a small corpus.

### 5. Estimating Position Bias without Intrusive Interventions (WSDM 2019, Cornell + Google)
- Source: `https://research.google/pubs/estimating-position-bias-without-intrusive-interventions/` (abstract)
- Approach: harvest preference signal from "intervention data" created by **several different ranking functions in historical logs** and produce consistent propensity estimates — no human relevance labels, no intrusive intervention, no restrictive relevance-modelling assumptions.
- Validation systems: **Arxiv Full-text Search** and **Google Drive Search**; the former is public full-text paper search, so neither system may be called a private or personal corpus.
- **Transferable to NMG:** historical ranking changes may supply analyzable exposure differences, but a version change by itself is not a valid intervention or causal comparison; overlapping queries/items, comparable contexts, actual exposure records and the method's identification assumptions are required.
- **Not transferable:** it needs "several ranking functions that produced logs over the same corpus"; NMG has no stable record of policy versions.

### 6. Towards Disentangling Relevance and Bias in Unbiased Learning to Rank (KDD 2023, Google)
- Source: `https://arxiv.org/pdf/2212.13937` (first half of the PDF, including abstract, method and experiment tables; same paper on the Google Research site)
- Problem: in two-tower ULTR the **bias tower is confounded through association with true relevance**, because **position is decided by the logging policy (the previous production model), which contains relevance information**.
- Online A/B (Chrome Web Store, 4 weeks):
  - Biased single-tower model: click-through rate **+1.21%** but **users with any click −5.78%**;
  - Debiased GradRev: click-through rate **+2.90%**, users with any click **+0.96%**.
- Source conclusion: the biased model only makes a few users click more **while the rest click less**; after debiasing both volume and user count rise.
- **Transferable to NMG:** direct evidence of "clicks up, experience down", supporting **not treating "was read" as a purely positive signal**, and supporting watching **how many distinct memories or users are covered** rather than total count alone.

---

## 3. Multiple objectives, long-term utility and exploration

### 7. Focus on the Long-Term: It's Better for Users and Business (KDD 2015, Google)
- Source: `https://research.google/pubs/focus-on-the-long-term-its-better-for-users-and-business/` (abstract)
- Findings: short-term A/B effects **do not always predict** long-term effects; establishes a method to quantify "long-term user learning"; ad blindness and visibility are driven by the quality of ads **seen or clicked before**; focusing on user satisfaction ultimately produced a **50% reduction in ad slots**.
- **Transferable to NMG:** immediate and long-term benefit of one impression can conflict; "fewer impressions" may be the correct answer rather than a regression.
- **Not transferable:** quantifying long-term effects needs a cross-round experimentation platform; NMG has none and **cannot claim it can measure long-term utility**.

### 8. Recommending What Video to Watch Next: A Multitask Ranking System (RecSys 2019, Google/YouTube)
- Source: `https://research.google/pubs/recommending-what-video-to-watch-next-a-multitask-ranking-system/` (abstract)
- Key points: several **competing** ranking objectives plus **implicit selection bias** in user feedback; MMoE soft parameter sharing inside a Wide & Deep framework to mitigate selection bias.
- **Transferable to NMG:** "relevance" and "whether to show" are different objectives and need separate modelling, not one compressed score.

### 9. Learned Ranking Function: from short-term behaviour prediction to long-term satisfaction (RecSys 2024, Google/YouTube)
- Source: `https://arxiv.org/html/2408.06512v1` (body read, including algorithm and deployment)
- Approach: models ranking as **slate optimization** that directly maximizes long-term satisfaction, with a **constrained optimization** algorithm (primary objective max, secondary `J_k ≥ β_k`; closed-form for one constraint, applied in sequence for several); exploration promotes a random candidate to the top with probability **ϵ**.
- Engineering preconditions: **on-policy** training, with all models trained on only **about 1% of traffic** so they can be compared side by side; the reward is "user satisfaction on watch" (citing Christakopoulou et al. 2021); the previous system was a heuristic ranking function **tuned by Bayesian optimization**.
- **What NMG explicitly cannot borrow:** it needs on-policy sampling and multi-model parallel traffic, which NMG lacks; the definition of the "long-term satisfaction" reward relies on Google's satisfaction proxies and cannot be reused as-is.
- **Transferable principles:** (a) write multi-objective goals as explicit primary/secondary constraints rather than a hand-tuned weighted sum; (b) exploration must be **bounded, small-share and reversible** (1% of traffic or probability ϵ), never globally unconstrained.

### 10. Sampling-Bias-Corrected Neural Modeling (RecSys 2019) / Top-K Off-Policy Correction (WSDM 2019)
- Source: two Google abstracts plus `https://arxiv.org/html/1812.02353` (body, sections 4–5)
- The Top-K paper states plainly that **"learning from logged feedback is affected by bias, because only feedback on items selected by the previous recommender is observable"**; importance weights have **extremely high variance** when π and β diverge, so they use a first-order approximation (slightly biased, low variance, bounded error); the **behaviour policy must be estimated from logs** (several agents exist in the system, some deterministic).
- **NMG conclusion:** to debias against "policy behaviour" one must first record **who showed what, under which policy, in what order**. `RecallInstance` already stores ordered candidates and scores, and array order can supply candidate position; but that does not prove final visible position, collapse or repeat-disclosure state, or actual exposure probability were recorded, so it is not yet enough to support such estimates.

---

## 4. The closest item to NMG: repeated impressions and cooling

### 11. Deep Neural Networks for YouTube Recommendations (RecSys 2016, Google/YouTube)
- Source: `https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45530.pdf` (full PDF read)
- Directly relevant text:
  - *"Features describing the frequency of past video impressions are also critical for introducing 'churn' in recommendations (successive requests do not return identical lists). **If a user was recently recommended a video but did not watch it then the model will naturally demote this impression on the next page load.**"*
  - Uses **implicit feedback** (completion) rather than explicit likes because implicit history is orders of magnitude larger and can produce recommendations in the long tail.
  - *"Ranking by click-through rate often promotes deceptive videos that the user does not complete ('clickbait') whereas watch time better captures engagement."*
  - **Training examples come from all site-wide watches**, not only watches produced by its own recommendations; otherwise it "would be biased towards exploitation" and new content could not surface.
  - A **fixed number of examples per user**, so a few heavy users do not dominate the loss.
  - An **example age** feature: the model naturally favours history, so "sample age is fed as a feature during training" and set to zero at serving time to correct non-stationarity.
  - The choice of surrogate learning problem matters **far more** than offline metrics; "live A/B results do not always correlate with offline experiments".
- **Transferable to NMG (most directly):** "recently shown but not consumed → naturally down-weighted next time" is a **ranking feature industry already uses**, and it is **bounded and recoverable** (not deletion, not a change to truth). This matches the intended "context down-weighting plus repeat-injection cooling".
- **Transfer limits and cautions:** (a) large-scale multi-user experiments differ from a single user's private corpus, so sample size must be checked; (b) it validates effects with A/B, while NMG has authorized only controlled offline validation, with no corresponding online evidence; (c) the paper itself says the effect of such features is **hard to measure offline or with a single metric** — so "adding it makes things better" cannot be promised.

---

## 5. Can it transfer to NMG: item-by-item verdict

| Literature conclusion | Precondition | Does NMG have it | Verdict |
| --- | --- | --- | --- |
| No click / no read ≠ negative signal (good abandonment) | none | yes | **can be adopted directly as an interpretive principle** |
| Summary-level utility ≠ document-level utility (CAS D vs R) | two display levels | yes (`header`/`exact`) | **can be adopted directly as an interpretive principle** |
| Clicks confound position and exposure bias | actual exposure logs | candidate order exists, actual visibility unverified | cannot claim debiasing just by adding position |
| Intervention-free propensity from multi-ranker history | multi-policy history | **missing** | needs policy-version records first |
| Impression-frequency feature (YouTube) | real impressions and context | unverified | hypothesis only; no automatic penalty for not getting |
| Long-term utility ≠ short-term utility | A/B or long-term reward | **missing** | can only be declared an unmeasured goal |
| Slate optimization + constrained multi-objective | on-policy sampling | **missing** | can borrow only the primary/secondary constraint formulation |
| Low-frequency, mutable satisfaction sampling (CAS survey) | user can mute | yes (same `<nmg_nudge>` channel) | **researchable, but must not ask every turn** |

## 6. Where human rating actually sits at Google (verified in official sources)

- **Search Quality Rater Guidelines update announcement** (Google Search Central Blog, 2023-11-16): *"these guidelines are what are used by our search raters to help **evaluate** the performance of our various search ranking systems, and **their ratings don't directly influence ranking**."*
- **How Search Works — rigorous testing** (official Google page): "719,326 search quality tests", *"These ratings **do not directly impact ranking**, but they do help us **benchmark** the quality of our results"*; the same page lists the quantities observed in live traffic experiments as *"what people click on, how many queries were done, **whether queries were abandoned**, or how long it took for people to click on a result"* — abandonment is one of the officially listed experimental observations.
- **Official Google Cloud blog (Google's internal search, Moma)** — the closest private-corpus case to NMG: *"we **continuously train on our own usage logs of the last four weeks**"*; *"Generate the training data from search logs that capture **which results were clicked for which queries**"*; *"**Each click on a document gets a label of 1, everything else a label of 0.**"* The same article states: *"even inside Google we can't use our web search technology, because that assumes a **fully public dataset, a lot of traffic, and more active content owners**"*, and *"each person has individual goals, access levels and needs"*.
- Secondary (SEJ quoting Danny Sullivan, not primary): *"this rating does not directly impact how this page or site ranks"*; raters compare **the current results page against a candidate improved page**, and the >10,000 rater figure is secondary.
- Classical LTR (RankNet / Burges et al. 2005, ICML "Learning to Rank using Gradient Descent") did **train ranking models on human relevance judgements** — a historical path that does not contradict "production uses behaviour, ratings only benchmark", because these are different eras and different layers.

**Conclusion:** by Google's own public statements, human ratings serve **evaluation and benchmarking** (including comparing two result pages) and **do not directly change ranking**; that does not exclude human labels being used indirectly for training, calibration or system improvement. Moma's click training is the public case for that internal search system and does not determine all training signals of public Search.
**Added reading (see §7):** YouTube's long-term satisfaction reward is constructed as in Christakopoulou et al. 2021 (RecSys / ICML RL4RealLife).

## 7. Three scale questions (official primary sources read)

### 7.1 How long-term satisfaction is measured — Christakopoulou et al. 2021 (arXiv:2209.15166, body read)

Two steps: proactive user ratings are the human feedback, and a model predicts satisfaction for un-answered consumed items; this is not per-item professional rater labelling.

1. **Survey sampling:** *"These surveys are shown **uniformly to all users**, asking them to rate on a scale how satisfying they found a **sampled item from their recent engagement history**."* (1–5 scale). **Response rate about 2%:** *"users tend to not respond to surveys— **response rate is around 2%** in our case."*
2. **Imputation model:** *"only being able to observe how satisfied users are with a **tiny fraction** of user-item interactions... **imputation models** can be useful in predicting satisfaction level for **all items users have consumed**"*. The reward is `r = f(r_u, r_e)` (equation 6, with additive/multiplicative/power/hinge/sigmoid combinations); the policy network and satisfaction imputation head are **trained jointly as multiple tasks**.

Analysis data: *"More than **two million** interactions with survey responses"*. The survey beats like/dislike because *"most users tend to not engage in post-click actions such as likes, dismissals"*. Satisfaction and completion rate point the same way but have **very high variance**, so both must be *"appropriately balance[d]"*.

### 7.2 Rater scale (official Google blog "How insights from people around the world make Google Search better")

- **"a group of more than 10,000 people all over the world we call 'search quality raters'"** (primary, not secondary).
- Guidelines run **>160 pages**; the task is to sample queries (*"say, a few hundred"*), assign them in groups, and compare **the current page against a candidate improved page**.
- Scale: *"more than **383,605 search quality tests and 62,937 side-by-side experiments**"*; the official How Search Works page (2023): **719,326** quality tests / **16,871** live experiments / **4,781** launches.
- Official statement that page-by-page rating is impossible: *"With **hundreds of billions of pages** that are constantly changing, there's no way humans could evaluate every page on a recurring basis."* → humans can only **sample and aggregate** for benchmarking.

### 7.3 Training-signal scale

| System | Training signal | Scale (source text) |
| --- | --- | --- |
| YouTube candidate generation + ranking (RecSys'16) | implicit watch | *"approximately **one billion parameters**... trained on **hundreds of billions of examples**"*; corpus of millions of videos, hundreds of candidates, dozens shown, several thousand negatives sampled |
| YouTube LRF (long-term satisfaction, RecSys'24) | on-policy user trajectories | model *"roughly **Θ(10⁴) parameters**"*; only **1% of traffic**; *"trajectories from the **past few days**"* |
| Google internal search Moma (official blog) | click logs | *"usage logs of the **last four weeks**"*; **130,000 weekly users** |
| Public Search ranking | undisclosed | billions of queries |
| Satisfaction signal | survey | **2% response rate**, >2 million rows |
| CAS study (for comparison) | — | 12 people / 2334 sessions / **243** satisfaction rows |

**Applicability boundaries for NMG:**

1. 2% is a survey response rate, not sampling or label coverage over all interactions. That imputation experiment used large-scale interactions, which neither proves single-user imputation impossible nor promises it is reliable at NMG's sample size.
2. Google states quality ratings are used for evaluation and do not directly change ranking; that does not prove all human labels are barred from training. NMG can start with fixed-sample evaluation; whether to train is a separate decision needing data and authorization.
3. Moma (130k weekly users, four-week rolling) cannot reuse Google's own web search technology, which does not mean no public retrieval algorithm can serve a private corpus.

## 8. Private corpora: where the ceiling is and where navigation preference comes from

**Sources:**
- Bendersky, Metzler, Najork, Wang, "Searching Personal Collections", Chapter 14 in *Information Retrieval: Advanced Topics and Techniques*, ACM 2025 (arXiv:2412.12330) — all authors at Google.
- Bergman, Beyth-Marom, Nachmias, Gradovitch & Whittaker 2008, *ACM TOIS* 26(4).
- Bergman, Tene-Rubinstein & Shalom 2013, *Personal and Ubiquitous Computing* 17(3), 583–590.
- Benn et al. 2015, *Nature Scientific Reports* 5:14719.
- Spotify, "Do LLM-judges Align with Human Relevance in Cranfield-style Recommender Evaluation?" (arXiv:2511.23312).

### 8.1 Private versus public (three points from Chapter 14)

1. *"Users are typically aware of most, if not all, of the items that exist in the collection."*
2. *"Personal collections are typically many orders of magnitude smaller than public collections."*
3. *"...while [web] search engines are optimized for **precision**, personal search tends to be optimized for **recall** — specifically, to ensure that when a user is searching for a known asset, that asset is among the retrieved assets."*

Beyond ranking, two more considerations: (a) **cue expression** (the dominant task is known-item search; the root cause of failure is memory failure; users remember content rather than formal descriptors — what the source calls the *"raison d'être"* of known-item retrieval; measured *"an average of about **two reformulations** per refinding task, suggesting that personal search indeed suffers from **recall issues**"*); (b) **decidedly scarce judgement sources** (Enron 619,446 messages / 158 people, *"neither queries nor relevance judgments"*; W3C/TREC-2005 Enterprise; **Avocado** 279 accounts / ~2M messages, 65 queries × ~100 results, each labelled for **relevance and sensitivity**; the desktop pooling set was never published for privacy). Privacy blocks research directly: *"difficult to conduct due to user privacy concerns, which make it all but impossible to analyze consumer email search behavior."*

### 8.2 Limits of temporal-preference and navigation studies

Chapter 14 links temporal cues to episodic memory. The user offered another explanation: temporal order may be a fallback after content-cue retrieval fails. The available material cannot settle that hypothesis.

- The 2013 study's conclusions about expressing needs and attention resources came mainly from abstract and citations; this round did not obtain the PDF, so it is not treated as full-text verified.
- Bergman et al. 2008 report that even after search improved, folder navigation was still preferred. Folder navigation is not temporal sorting, and improving one searcher does not remove difficulty in expressing content cues.
- Benn et al. 2015's resource differences and similar task success rates support that navigation and search may carry different costs; they do not prove temporal preference is entirely cost-driven, nor exclude a fallback role.

NMG may study whether temporal or contextual anchors improve retrieval, but cannot derive temporal sorting directly from human navigation preference. An LLM can also form vague or wrong queries, so it cannot be assumed to have no cost in expressing a need.

### 8.3 Where an LLM judge can serve as a judgement source

Spotify (arXiv:2511.23312) reports agreement between system ranking and human judgement of **Kendall's τ = 0.87**, which is not per-candidate label accuracy. Richer metadata and longer history helped alignment in that experiment; it does not prove NMG obtains the same gain, and a judge is not cost-free ground truth.

## 9. Mapping to NMG: research inspiration and hypotheses to verify

This section separates original paper results, transfer inspiration and NMG's verified behaviour; external results are not implementation proof. The 19 historical recalls cannot prove current scores carry no information, nor exclude gains from reweighting, better candidate generation or better ranking. A bounded score is not a calibrated relevance probability, and a structural match does not guarantee the content answers the question.

| Study | Inspiration for NMG | What cannot be concluded / required precondition |
| --- | --- | --- |
| KDD'23: the position policy carries relevance information, and total clicks can diverge from users who click | read counts are biased behavioural observations and cannot be the only quality objective | does not prove NMG has the same confounding or that optimizing current ranking is futile; the local bias mechanism must be identified first |
| CAS + good abandonment: summary and full text have different utility, and a summary can satisfy the need | keep the preview needed to judge relevance, and distinguish "summary is enough" from reading exact evidence | does not require nominating or showing only full text; information loss versus resident context cost must be compared, and not reading stays unknown |
| YouTube'16: uses site-wide watches, not only recommendation-produced watches | user-chosen active search and automatic recall can supply different observation sources to a shared retrieval | keep entry, selection mode and evidence source separate; merging data does not merge label meaning and is not factual-correctness supervision |
| YouTube'16: impression frequency and example age features | repeated impressions and recency can be studied as independent, interpretable features | needs real impressions and task context; not reading is not an automatic penalty, and sample age is not memory event time or a universal recency preference |
| SIGIR'16 / WSDM'18 / WSDM'19: sparse behaviour and position bias | first verify whether logs support cross-query aggregation and exposure analysis | a historical version difference is not a natural causal comparison; candidate array order exists, but final display, collapse and policy records still need verification |
| LRF: primary and secondary objective constraints | compare ranking quality under a fixed budget while constraining evidence loss, context cost and tool turns | borrow only the objective formulation, not slate, bandit or on-policy training; whether enough logs exist is a separate verification |
| Official rater and Moma cases | compare the original and a candidate side by side on a fixed question set; separate behavioural observation from independent evaluation | "does not directly change ranking" does not mean labels are never used for training; Moma is not all public Search training signals |
| Satisfaction surveys and personal-corpus research | state the applicable range for sample size, privacy and known-item refinding | 2% is a response rate; single-user learning cannot be declared impossible, and known-item recall priority cannot be applied directly to automatic injection |

### 9.1 Direction fixed this round

Active and automatic recall share part of the retrieval path; fewer irrelevant results and better ranking can help both, but benefit size must be observed separately. Automatic recall is a best-effort aid and does not guarantee complete memory coverage; tool usage rate is not a current objective. Shrinking each visible block and keeping the prefix cache come first, with no harness-specific compression adapter.

### 9.2 Order of bounded development

1. Use fixed questions to find where the correct evidence is lost — candidate generation, ranking, budget or display — and fix one reproducible shared problem.
2. Compare output slimming separately: reduce duplicate wrappers while keeping necessary relevance cues, scope/time/source and the exact-read channel; do not presuppose that pure-ID nomination beats a content preview, nor fix counts or character thresholds in advance.
3. Before starting, freeze the question set, the two-arm comparison and the exit conditions; do not treat an old sample's noise rate as the current baseline.

Candidate coverage, top-rank placement, irrelevant injection volume and actual visible content cost are different metrics and cannot be compressed into one `RecallInstance` ratio. The five existing instance labels are coarse observations, not a substitute for candidate-level qrels, ranking metrics or correct abstention verdicts. Shared changes must be checked on both auto and explicit results so an aggregate does not hide a regression; symmetric benefit on both sides is not required.

### 9.3 Mechanisms deliberately not implemented

Do not restore a model gate or depend on a per-turn answer-model score; do not treat get, no re-search, tool completion or silence as factual support. Behavioural debiasing, cooling, satisfaction imputation and policy learning all need data and preconditions verified first; a Google precedent is not a reason to ship. Automatic recall may legitimately return nothing when relevance is insufficient; a structural hit or score gap is only a hypothesis, not a sufficient criterion.

## 10. Evidence gaps that must be admitted

- Everything above is **external literature** and **cannot** be used to assert NMG's current candidate noise rate or any specific threshold.
- CAS's data scale (12 people / 243 satisfaction rows) shows even Google had to collect specially to obtain satisfaction labels; if NMG studies satisfaction it must state its sampling and independent-judgement method, and this round approved neither per-turn self-rating nor satisfaction training.
- Entries read only as abstracts (the abstract parts of 3, 5, 7, 8, 10) must not be used as implementation grounds.
- Not read in full this round: any Google production weights, decay formulas, or "this approach was accepted".
- No longer gaps: long-term satisfaction measurement (§7.1), rater scale (§7.2) and training-signal scale (§7.3) were all read in official or primary text.
- Verified as official primary: rater ratings **do not directly influence ranking**, live-experiment observations include abandonment, Google's internal search (Moma) **trains on click logs**, and that system cannot reuse Google's own web search technology (see §6).
