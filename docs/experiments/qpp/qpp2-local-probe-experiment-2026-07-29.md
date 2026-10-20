# QPP2 local-probe experiment (2026-07-29)

[English](qpp2-local-probe-experiment-2026-07-29.md) | [简体中文](qpp2-local-probe-experiment-2026-07-29.zh-CN.md) · [Terms](qpp2-local-probe-experiment-2026-07-29.terms.yaml)

> **Status:** Historical research record. The experiment-specific `QPP1`/`QPP2` names below do not define the current runtime switches or prove that today's adapters execute these experimental models. All three named result directories are absent from this checkout; the figures below are retained report values, not independently reproduced here. See the [current QPP design](../../design/retrieval-confidence-controller.md).

## Experimental role definitions

For this experiment only:

- `QPP1` predicted the width of a candidate pool from global memory and chose a Fibonacci expansion tier.
- `QPP2` did not search for another Top-1. It ranked necessary evidence versus noise within the QPP1 candidate set and controlled the context shown to the Agent.

The target was not simply to retrieve more candidates. It was to improve official-evidence recall under a fixed output count or token budget.

## First-principles constraint

If a second stage uses exactly the same document vectors and cosine function, restricting the set to Top-K cannot change `cos(query, document)` or the ranking. Local softmax or z-score normalization only changes score scale; it creates no new information.

A listwise local probe therefore needs at least one candidate-set-conditioned signal:

1. semantic similarity between candidates;
2. graph connectivity between candidate nodes;
3. an independent reranker or cross-encoder;
4. local statistics such as local IDF, centering, or whitening; or
5. second-order correlation propagation over the candidate set.

The prototype used second-order propagation:

\[
r_i^{(2)} = \alpha r_i^{(1)} + (1-\alpha)\sum_j \operatorname{softmax}_j\left(\frac{\cos(d_i,d_j)}{T}\right)r_j^{(1)}
\]

The differentiable controller used direct relevance, within-set similarity, second-order support, graph connectivity, and query intent as features. To protect high-confidence results, it kept 15 first-stage safety anchors and let QPP2 select only the remaining five from the expanded region.

## Initial experiment protocol

- Data: 150 LoCoMo questions, 30 per category.
- Multi-hop: official category 1.
- Evidence labels: official LoCoMo evidence IDs.
- Vectors: `BAAI/bge-small-en-v1.5`.
- Train/validation: five-fold stratified cross-validation.
- LLM calls: none.
- Candidate ceiling: 50.
- Compared outputs: fixed Top-20, dynamic QPP1 tiers, QPP1 + QPP2, and all 50 candidates.

The report named the result directory `evals/controller/results/2026-07-29T09-28-10.616Z`.

### Results: all 150 questions

| Strategy | Evidence recall | Mean records | Mean estimated tokens |
| --- | ---: | ---: | ---: |
| Fixed Top-20 | 0.2567 | 20.0 | 9,145 |
| Dynamic QPP1 tiers | 0.4439 | 34.2 | 15,618 |
| QPP1 + differentiable QPP2 | 0.2639 | 20.0 | 9,126 |
| Diversity-based local selection | 0.3183 | 20.0 | 9,132 |
| Full Top-50 | 0.5911 | 50.0 | 22,779 |

### Results: official multi-hop category

| Strategy | Evidence recall | Mean estimated tokens |
| --- | ---: | ---: |
| Fixed Top-20 | 0.1167 | 9,124 |
| Dynamic QPP1 tiers | 0.2444 | 15,493 |
| QPP1 + differentiable QPP2 | 0.1361 | 9,109 |
| Diversity-based local selection | 0.1417 | 9,009 |
| Full Top-50 | 0.3389 | 22,752 |

At the same 20-record output budget, QPP2 showed only a small positive signal. The learned strategy underperformed simple node-diversity selection and failed to retain most of the recall benefit from QPP1's expanded candidate pool. The experiment therefore kept it in shadow/research rather than the Pi default path.

## Intra-list hypothesis check

For 27 queries with at least two official multi-hop evidence items, the report compared BGE vectors directly:

- evidence-to-evidence pairs: 64;
- evidence-to-noise pairs: 3,354;
- mean evidence-to-evidence similarity: 0.8699;
- mean evidence-to-noise similarity: 0.8495;
- mean gap: 0.0204.

The evidence items were slightly more coherent on average, but the signal was weak and distributions overlapped substantially; a single threshold could not reliably denoise the list. Bridge evidence may also be semantically complementary rather than textually similar, so graph paths, entity coverage, and diversity cannot be replaced by pure similarity.

## Literature notes recorded by the report

The report identified related work on post-retrieval/listwise/groupwise QPP, retrieval coherency, context-aware reranking, score magnitude and variance, and query-specific reranking depth. It cited *Groupwise Query Performance Prediction with BERT* as jointly modelling Top-K ranking context with under 1% additional compute over its corresponding BERT predictor.

The report could not verify the specific attribution “Second-order Relevance as local QPP, improving 15–20%” in the official SIGIR 2023 list. It found a same-named 2021 e-commerce search paper using a query-product behavior graph and reporting 4.3% average offline gain. That paper may motivate neighborhood propagation, but is not experimental evidence for NMG QPP2. These external citations are preserved as recorded; they were not rechecked in this documentation pass.

## Decisions recorded at the time

1. Keep QPP1 candidate-width learning because it showed a recall gain for the measured multi-hop subset.
2. Define experimental QPP2 as candidate-set-conditioned necessary-evidence selection, not “searching for Top-1 again.”
3. Keep the then-current differentiable QPP2 in shadow; it did not change Pi's formal context.
4. Preserve high-confidence safety anchors unless cross-validation shows full reranking does not regress.
5. Compare simpler, interpretable set strategies first: query relevance plus node coverage; second-order propagation; graph paths; and a small cross-encoder reranker.
6. Connect a QPP2 selector to Pi only if it reliably beats fixed Top-K at the same token budget.

These are historical experiment decisions, not the current runtime contract.

## Pairwise QPP2 and dynamic compression: 150-question follow-up

The follow-up trained QPP2 with pairwise hard negatives: for each official evidence item, its necessity score should exceed that of highly ranked noise in the first-stage list. This learns within-list order, not calibrated absolute probabilities.

Under the same 150-question LoCoMo protocol, full QPP1 expansion averaged 34.11 records and 15,584 estimated tokens, with evidence recall 0.4556. Dynamic truncation by QPP2 local probability mass produced:

| Retained local mass | Evidence recall | Evidence retention vs full QPP1 | Record compression | Token compression |
| ---: | ---: | ---: | ---: | ---: |
| 90% | 0.3406 | 87.33% | 21.07% | 21.27% |
| 95% | 0.3672 | 90.67% | 11.70% | 11.83% |
| 98% | 0.4472 | 99.00% | 4.51% | 4.57% |

The report named `evals/controller/results/2026-07-29T09-37-15.222Z`. The 98% tier was nearly lossless but compressed little; the 90–95% tiers saved more context while losing a meaningful amount of evidence. The report therefore proposed query-level confidence calibration rather than one fixed tier.

## Full LoCoMo evidence test

The full run used 1,982 LoCoMo questions with official evidence IDs and 2,814 labelled evidence items; BGE, five-fold cross-validation, 80 epochs, and no LLM calls were retained. The report named `evals/controller/results/2026-07-29T09-49-23.691Z`.

### Overall results

| Strategy | Macro evidence recall | Mean records | Mean estimated tokens |
| --- | ---: | ---: | ---: |
| Fixed Top-20 | 0.3441 | 20.0 | 9,005 |
| Dynamic QPP1 search pool | **0.5204** | 34.0 | 15,282 |
| QPP1 + QPP2 90% | 0.4294 | 25.1 | 11,278 |
| QPP1 + QPP2 95% | 0.4511 | 27.3 | 12,274 |
| QPP1 + QPP2 98% | 0.4887 | 29.5 | 13,283 |
| Top-50 candidate ceiling | 0.7010 | 50.0 | 22,474 |
| Oracle Fibonacci | 0.7010 | 20.4 | 9,205 |

QPP1 was 17.63 percentage points above Top-20, with 400 per-question wins, zero losses, and 1,582 ties. Because the then-current QPP1 mostly expanded rather than shrank the pool, this shows that a larger pool recovered evidence in this run; it does not show that the controller learned accurate query-specific budgets.

For 1,559 questions with exactly one official evidence item, recall was 39.13% for Top-20, 58.50% for QPP1, and 55.04% for QPP2 98%. For 423 multi-evidence questions, macro recall was 17.01%, 28.23%, and 26.14%, respectively. In official category-1 multi-hop questions, the corresponding values were 14.29%, 23.89%, and 21.50%.

### QPP2 compression

Relative to the complete QPP1 visible set:

| QPP2 tier | Evidence retention | Record compression | Token compression |
| ---: | ---: | ---: | ---: |
| 90% | 89.88% | 26.06% | 26.07% |
| 95% | 92.27% | 19.56% | 19.56% |
| 98% | 96.31% | 12.96% | 12.97% |

At the 98% tier, 77 of 1,982 questions lost at least some evidence already recovered by QPP1; the other 1,905 tied. The report therefore did not recommend this as a default path: the experiment showed listwise compression, not the near-lossless safety needed for default activation.

### Budget-confidence diagnostic

The reported correlation between QPP1's predicted budget and the oracle Fibonacci budget was only `0.0205`; mean absolute tier error was `20.33` records:

- 420 questions were under-allocated;
- 1,205 were over-allocated;
- 357 matched the oracle.

The oracle reached the Top-50 recall of `0.7010` using a mean of 20.4 records; QPP1 used 34.0 records and reached 0.5204. The report's central conclusion was that fixed Top-K should be replaced by variable budgets in principle, but the measured confidence signal had not learned reliable per-query allocation.

It proposed calibrating query-level evidence-completeness probabilities and evaluating calibration error, budget/oracle correlation, and the recall-token curve. QPP2 was to remain a shadow compressor until evidence retention reached a chosen safety threshold.

### Recorded training and runtime costs

- corpus preparation: 8.4 s;
- query preparation: 284.2 s;
- final QPP1 training: 21.8 s;
- five-fold QPP1/QPP2 budget training: 1,021.1 s;
- training steps: 956,160;
- embedding requests: 3,984;
- embedded texts: 104,457;
- LLM calls: 0.

The report attributed offline training time mainly to unbatched pairwise QPP2 computation, not online inference. It reported mean QPP2 online scoring of about 2.06 ms and recommended batching pairwise loss or adding resumable checkpoints before another large training run.

## Historical proposal: variable retrieval and visible sets

The original supplement proposed a division of labour:

```text
QPP1: predict whether the current candidate pool covers the needed information
  └── expand the search pool through Fibonacci tiers when insufficient

QPP2: estimate which candidates are worth showing in full
  └── retain necessary evidence and compress expanded noise
```

It proposed variable search and visible set sizes instead of fixed Top-20:

\[
K_{search} = \min\{k : \Pr(\text{evidence complete}\mid q,R_{1:k}) \geq \tau_s\}
\]

\[
R_{visible} = \{r_i \in R_{1:K_{search}} : \Pr(\text{necessary}_i\mid q,R_{1:K_{search}}) \geq \tau_v\}
\]

The proposal retained a minimum safety prefix, record/token/latency ceilings, protections for conflicts and fixed user constraints, and progressive expansion rather than jumping to a fixed large pool. It also warned that pairwise QPP2 scores were rankings, not calibrated probabilities; cancelling fixed Top-K would require held-out calibration and reporting evidence retention, compression, calibration error, and worst-case recall loss by query category.

This proposal and its equations are historical research, not the current product semantics. Consult the [current QPP design](../../design/retrieval-confidence-controller.md) and [progressive-recall contract](../../design/fibonacci-progressive-recall.md).

All three referenced result directories are absent from this checkout: `2026-07-29T09-28-10.616Z`, `2026-07-29T09-37-15.222Z`, and `2026-07-29T09-49-23.691Z`. The measurements above are the preserved report values, not a fresh verification.