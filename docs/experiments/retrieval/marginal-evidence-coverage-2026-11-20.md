# Marginal evidence coverage under a character budget

[简体中文](marginal-evidence-coverage-2026-11-20.zh-CN.md) · [Terms used](marginal-evidence-coverage-2026-11-20.terms.yaml)

## Question and setup

Can an inexpensive estimate of new evidence coverage improve selection from
the same shortlist? The offline replay used 1,867 questions: 1,532 from
LoCoMo, 235 from BEAM, and 100 from LongMemEval. It reused cached 384-dimensional
BGE-small-en-v1.5 vectors with zero new embedding requests. Each question kept
its time filter, the three input rankings, and the RRF shortlist of at most
100 records. The replay allocated no fixed places to the first three hybrid
results.

The main comparison used only the existing records. In a separate comparison,
all arms received the same additional raw messages immediately before and after
the first three ranked records. The packers charged full record text and
separators to the same budget and deduplicated records with the same single
original source. The three output limits were 20 records and 2,500 Unicode
characters, 32 and 4,000, and 50 and 6,000.

The fixed-order controls either scanned once or kept the results of a
1,500-character pass while filling successive larger budgets. The length
control divided a relevance prior derived from the RRF rank by the square root
of record length, with a 100-character floor. The marginal alternatives used
the same cost correction. One added credit for previously uncovered
IDF-weighted query terms. The other also gave credit for increases in estimated
support for conjuncts and requested answer parts such as a reason, date, or
outcome. Support for each part was the maximum found in any selected record.
Selection used query text and candidate features. Gold labels were used for
evaluation only.

## Results

These are marked-evidence recall rates for 32 records and 4,000 characters
with the original record pool.

| Packer | LoCoMo | BEAM | LongMemEval |
| --- | ---: | ---: | ---: |
| One ranked pass | 67.25% | 14.89% | 81.76% |
| Staged ranked pass | 67.16% | 24.49% | 88.24% |
| Relevance and length | 65.12% | 26.65% | 92.35% |
| Add uncovered query terms | 65.46% | 26.65% | 92.35% |
| Add query parts | 65.55% | 26.53% | 92.35% |

Length correction accounts for most of the gain over the staged packer on BEAM
and LongMemEval. On LoCoMo at 2,500 characters, query-part coverage added
72 gold evidence items and displaced 173 compared with the staged packer
(56.18% versus 60.48%). At 6,000 characters its recall was 72.36% versus 72.23%,
with a paired 95% bootstrap interval of −0.69 to +1.07 percentage points.
The bootstrap sampled whole evaluation scopes. Warm marginal packers took
about 0.07 to 0.28 ms at P95 across the measured configurations. Timing begins
after ranking, feature extraction, and source reads.

The matched pin ablation used the same candidate set and RRF scores. At 20
records and 4,000 characters, the staged packer at 3, 1, and 0 forced hybrid
results reached 63.97%, 64.05%, and 63.93% on LoCoMo, 15.61%, 18.73%, and
24.49% on BEAM, and 81.76%, 86.47%, and 88.24% on LongMemEval.

## Graph probe and limits

The replay stores lacked explicit edges suitable for scoring graph
coverage. Eight constructed cases used the actual SQLite edge and evidence
reads with a fixed candidate list. All four positive cases selected the
evidence that covered the requested reason, outcome, earlier state, or
dependency. All four guards withheld the bonus for a generic `related_to` edge,
reversed endpoints, an edge without source provenance, or a record whose
text lacked support. These cases establish behavior on the constructed inputs.

LoCoMo and BEAM mark source messages. LongMemEval marks answer sessions, so
its score can rise when more marked sessions are represented. Answer quality
and natural graph gains remain unmeasured. The tested packers are offline
variants. The [retrieval contract](../../design/design/progressive-retrieval.md#evidence-assembly)
owns the injected evidence ranker behavior.

The [measurement artifact](artifacts/2026-11-20-marginal-evidence-coverage.json)
retains dataset fingerprints, budgets, matched counts, whole-scope intervals,
timings, and the graph case outcomes. Frozen candidate and per-question replay
inputs are identified by hash.
