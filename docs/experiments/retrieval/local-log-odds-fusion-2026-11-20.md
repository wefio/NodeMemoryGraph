# Local log-odds fusion for SQLite hybrid retrieval

[简体中文](local-log-odds-fusion-2026-11-20.zh-CN.md) · [Terms used](local-log-odds-fusion-2026-11-20.terms.yaml)

## Question and setup

Can one fixed vector-to-BM25 weight improve both hybrid retrieval and economy
recall without tuning each library? The frozen replay used 1,532 LoCoMo, 235 BEAM,
and 100 LongMemEval questions with 3,351 marked evidence labels. The runs reused
cached 384-dimensional BGE-small-en-v1.5 query vectors and original time filters.
SQLite supplied BM25 and cosine scores for the union of both routes. Gold labels
were used for evaluation and the diagnostic held-out grid choice. The fixed
fusion calculates no label-dependent values at runtime.

The fixed arms center each route on the median of its positive scores and scale
it by their population standard deviation. A candidate with a BM25 hit uses
the weighted sum of both calibrated scores times √2. A candidate without a BM25
hit uses calibrated cosine alone. The 3∶1 arm assigns 0.75 to cosine and 0.25 to
BM25. The 6∶1 arm retains the relative vector and BM25 weights of the earlier
three-route comparison. The QARF arms vary that weight with query IDF, either
per query or averaged over the other scopes in the same dataset. The score-gap
arm estimates each route's strength from its standardized head-to-median gap.

## Weight sweep

The sweep changes weights across 40 fixed settings. Each arm uses the same
two-route depth and the same original-message adjacency rule for this comparison. That rule preserves the first 80 and admits up to 20 neighboring
records under the same date bounds. The output stays capped at 100 records.

| Candidates per route | Vector∶BM25 | Overall Recall@20 | Overall Recall@100 | BEAM Recall@100 |
| ---: | --- | ---: | ---: | ---: |
| 100 | 6∶1 | 57.65% | 81.92% | 69.51% |
| 100 | 3∶1 | 58.46% | 82.48% | 69.99% |
| 200 | 6∶1 | 57.98% | 82.04% | 69.63% |
| 200 | 3∶1 | 58.46% | 82.69% | 70.35% |

At depth 100, 3∶1 recovered 39 gold labels and displaced 20 relative to 6∶1.
The overall gain was 0.57 percentage points, with a scope-bootstrap 95% interval
of +0.19 to +0.96 points. The BEAM interval crossed zero. At depth 200, overall
Recall@100 was 82.07% with per-query QARF, 82.27% with the other-scope mean,
and 80.45% with the score gap. All three lost to 3∶1 on this objective. Leaving
one dataset out and selecting by the other two datasets' mean Recall@100 chose
3∶1 in all three depth-200 trials. The choices varied at depth 100.

At 3∶1, doubling route depth gained 0.21 points of overall Recall@100 and raised
the median number of scored candidates from 167 to 297. The recorded Pareto
front uses overall Recall@20, overall Recall@100, and BEAM Recall@100.

## Economy recall

The replay used the shared renderer, with a 160-code-point statement preview
per candidate. Coverage measures gold evidence accessible through delivered
references. The character caps count UTF-16 units.

| Ranking | 3 items / 1,000 | 5 items / 1,500 | 10 items / 2,500 |
| --- | ---: | ---: | ---: |
| Fixed three-route RRF | 33.39% | 39.72% | 48.13% |
| Fixed 3∶1 log-odds | 34.89% | 40.97% | 49.60% |
| Per-query QARF log-odds | 33.99% | 39.99% | 48.34% |
| Other-scope mean QARF log-odds | 34.05% | 40.56% | 49.15% |
| Score-gap log-odds | 33.57% | 38.65% | 46.43% |

At five items, 3∶1 recovered 157 gold labels and displaced 115. Gold visible
in the preview itself increased from 16.23% to 16.56%, and both arms had an
output length of 1,205 UTF-16 units at p95. Per-query QARF raised BEAM coverage
from 13.21% to 16.33% and reduced LoCoMo from 46.29% to 45.02%.

## SQLite read cost and verification boundary

The integrated test used 138 queries on SQLite copies. It compared ordinary
and economy engine searches with a common return cap of 20 records. The timer
includes candidate reads, cross-score reads, ranking, and original evidence
reads. Ordinary search also performs its bookmark lookup. Each query ran three
times, the first was discarded, and the last two ran in opposite arm order.

| Dataset | Queries | Ordinary p95, prior → 3∶1 | Economy p95, prior → 3∶1 |
| --- | ---: | ---: | ---: |
| LoCoMo | 41 | 18.4 → 15.8 ms | 18.9 → 13.8 ms |
| BEAM | 47 | 28.2 → 16.6 ms | 30.8 → 17.1 ms |
| LongMemEval | 50 | 23.6 → 20.8 ms | 24.2 → 20.7 ms |

The integrated change combines a smaller admission depth with the new scoring
rule. Score fusion over loaded candidates took 0.07–0.10 ms at p95. In a separate
BEAM read probe, scanning the query's matching BM25 scores once took 0.71 ms at
p95, excluding 0.11 ms to map candidate IDs. Restricting the FTS match by
candidate rowid took 8.70 ms at p95. The bounded cosine lookup for lexical
candidates took 0.25 ms at p95. All 138 integrated
queries matched the frozen 3∶1 top-20 ordering, and ordinary and economy queries
returned the same order. The earlier 6∶1 TypeScript port matched the Python
top 100 for all 1,867 questions at each depth, including the adjacency replay.

LongMemEval measures coverage of marked answer sessions. LoCoMo and BEAM mark
source messages. The experiment does not measure answer correctness, daemon or
provider latency, or an installed user's library. It made zero new embedding
requests. The [measurement artifact](artifacts/2026-11-20-local-log-odds-fusion.json)
records input fingerprints and aggregate results. The
[integration decision](../../decisions/implemented/2026-11-20-local-log-odds-fusion.md)
owns the shipped policy.
