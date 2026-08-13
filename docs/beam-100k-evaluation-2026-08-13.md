# BEAM 100K full evaluation (2026-08-13)

## Status

The first full OmniMemEval BEAM 100K NMG run is complete. Search, answer,
judge, metric, and report stages all produced usable artifacts. This is an NMG
backend result, not yet a capability delta: a matched no-memory/raw-session arm
with the same reader, prompt, questions, token budget, and judge is still
required.

## Pinned configuration

- dataset: official OmniMemEval BEAM, `100k` scale;
- questions: 400 across 20 conversations;
- memory backend: `nmg`;
- retrieval: top-K 20, `BAAI/bge-small-en-v1.5` record embeddings;
- QPP second pass: off;
- answer model: `deepseek-v4-flash`;
- judge model: `deepseek-v4-flash`, one run per rubric item;
- memory workers: 2;
- LLM workers used by this run: 32;
- failed search/answer/judge skipping: all off.

The ignored local artifact is:

`results/beam/nmg-nmg_beam100k_bge_records_20260726/exp_report.md`

under the local OmniMemEval checkout. Its replay config and environment snapshot
contain the complete reproducibility metadata without live credentials.

## Result

Overall Nugget Score: **0.6422 ± 0.3974** over 400 questions.

| Dimension | Score | Questions |
|---|---:|---:|
| abstention | 0.6125 | 40 |
| contradiction resolution | 0.7500 | 40 |
| event ordering | 0.2606 | 40 |
| information extraction | 0.7776 | 40 |
| instruction following | 0.8438 | 40 |
| knowledge update | 0.5750 | 40 |
| multi-session reasoning | 0.6276 | 40 |
| preference following | 0.9187 | 40 |
| summarization | 0.3433 | 40 |
| temporal reasoning | 0.7125 | 40 |

Pipeline integrity was 400 successful records and zero failed or skipped
records for each of search, answer, and evaluation.

## Retrieval cost

| Metric | Average | P50 | P95 |
|---|---:|---:|---:|
| add latency | 77.9 ms | 73.9 ms | 112.1 ms |
| search latency | 146.6 ms | 40.9 ms | 185.1 ms |

The mean is inflated by the abstention category (1,072.6 ms average search);
the other reported dimensions are mostly around 40–44 ms average. P50 is the
more representative ordinary-query number for this run.

## Model usage

| Stage | Calls | Prompt tokens | Completion tokens | Total tokens |
|---|---:|---:|---:|---:|
| answer | 400 | 398,392 | 952,205 | 1,350,597 |
| judge | 878 | 740,966 | 392,322 | 1,133,288 |
| combined | 1,278 | 1,139,358 | 1,344,527 | 2,483,885 |

The judge makes one request per rubric item, except event-ordering questions,
which use one ordering request. Therefore 400 judged questions do not imply 400
judge calls.

## Pipeline timing and engineering findings

- answer generation: 11,549 s (85.3%);
- judge: 1,974 s (14.6%);
- metric: 17 s;
- total original pipeline: 13,540 s.

This wall time is not representative of NMG retrieval. The answer stage was
dominated by upstream connection failures combined with a 600-second request
timeout and four retries. The judge also exposed a scheduling defect: the
advertised concurrency applied to whole questions while rubric items within a
question were serial.

The local OmniMemEval branch now:

1. executes rubric calls through one bounded API pool;
2. uses checkpointed question groups of 2–4 (default 4);
3. writes each completed question atomically;
4. defaults BEAM LLM concurrency to 16 and accepts ordinary 16–32 operation;
5. reads and writes reports explicitly as UTF-8 on Windows;
6. redacts both sides of replay environment diffs.

Mock validation with nine rubric items and four API slots observed peak
concurrency four and completed in 0.179 s with correct score aggregation.

## Interpretation and next gate

The strongest categories are preference following and instruction following;
event ordering and summarization are the clearest weaknesses. This run alone
cannot say whether NMG improved the Agent, because model ability and judge
variance are not controlled by a baseline comparison.

The next required benchmark step is a matched BEAM arm without NMG (or with the
official raw-session baseline if that is the benchmark-defined comparison),
using the exact same 400 questions, DeepSeek Flash answer/judge models, prompts,
and accounting. Report the paired score delta together with evidence recall,
tokens, and latency; do not compare this number against an unmatched run.
