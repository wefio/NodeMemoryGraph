# BEAM 100K full evaluation (2026-08-13)

## Status

The first full OmniMemEval BEAM 100K NMG run and a matched empty-memory control
are complete. Both arms used the same 400 questions, answer prompt, reader, and
judge. NMG scored **0.6422**, versus **0.2724** without retrieved memory, for a
paired mean gain of **+0.3698**. This demonstrates the value of the retrieved
NMG context on this fixed BEAM run; it does not isolate individual retrieval,
storage, graph, or QPP mechanisms.

## Pinned configuration

- dataset: official OmniMemEval BEAM, `100k` scale;
- questions: 400 across 20 conversations;
- memory backend: `nmg`;
- retrieval: top-K 20, `BAAI/bge-small-en-v1.5` record embeddings;
- QPP second pass: off;
- answer model: `deepseek-v4-flash`;
- judge model: `deepseek-v4-flash`, one run per rubric item;
- memory workers: 2;
- NMG-arm LLM workers: 32;
- empty-memory control: adaptive worker pool with minimum/initial 16 and maximum
  32, checkpointed in groups of 4;
- failed search/answer/judge skipping: all off.

The ignored local artifact is:

`results/beam/nmg-nmg_beam100k_bge_records_20260726/exp_report.md`

under the local OmniMemEval checkout. Its replay config and environment snapshot
contain the complete reproducibility metadata without live credentials.

## NMG result

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

## Matched empty-memory control

The control preserved every question, rubric, prompt, reader, and judge setting,
but replaced retrieved context with the empty string. It is therefore an
**empty-retrieval-context control**, not an official raw-session/full-history
reader. Answer and evaluation both completed 400/400 with no failed or skipped
records.

| Dimension | NMG | Empty memory | Delta |
|---|---:|---:|---:|
| **overall** | **0.6422** | **0.2724** | **+0.3698** |
| abstention | 0.6125 | 1.0000 | -0.3875 |
| contradiction resolution | 0.7500 | 0.1156 | +0.6344 |
| event ordering | 0.2606 | 0.0056 | +0.2551 |
| information extraction | 0.7776 | 0.1365 | +0.6411 |
| instruction following | 0.8438 | 0.5750 | +0.2688 |
| knowledge update | 0.5750 | 0.0000 | +0.5750 |
| multi-session reasoning | 0.6276 | 0.1129 | +0.5147 |
| preference following | 0.9187 | 0.7063 | +0.2125 |
| summarization | 0.3433 | 0.0471 | +0.2963 |
| temporal reasoning | 0.7125 | 0.0250 | +0.6875 |

On the 400 matched questions, NMG won 251, tied 123, and lost 26. A
deterministic 20,000-sample paired bootstrap over per-question score differences
gave a descriptive 95% interval of **[+0.3205, +0.4183]**. This interval was
computed after the run and is not a preregistered confirmatory test.

The abstention reversal is expected: with no context, refusing unsupported
answers is often correct. NMG's lower abstention score means retrieved context
also makes the reader answer some questions that should be refused. This is a
real precision/safety regression to inspect, not a reason to hide the category
inside the positive overall mean.

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
4. supports a bounded adaptive LLM worker pool (minimum/initial 16, maximum 32):
   sustained success grows the pool, while 429, timeout, and 5xx congestion
   signals shrink it without falling below the configured minimum;
5. reads and writes reports explicitly as UTF-8 on Windows;
6. redacts both sides of replay environment diffs.

Mock validation with nine rubric items and four API slots observed peak
concurrency four and completed in 0.179 s with correct score aggregation.

## Interpretation and next gate

The matched control supports the bounded claim that NMG-provided context improved
answer quality on this fixed BEAM 100K run. The largest gains occur in temporal
reasoning, information extraction, contradiction resolution, and knowledge
update—the categories that most directly require prior evidence. Event ordering
and summarization remain weak in absolute terms despite improving over the
control.

Token comparison is not valid for this pair. The NMG arm ran in one process and
its tracker contains all calls, while the empty-memory answer stage required
several checkpoint resumes and each process overwrote `token_usage_answer.json`;
the final file therefore contains only the last one-question invocation. The
empty-memory judge file is complete because judging finished in one process.
Future resumed runs must merge token ledgers instead of overwriting them before
token-efficiency claims are made.

The next benchmark gate is no longer another empty-memory run. It is (1) inspect
the 26 paired regressions, especially abstention; (2) add cumulative token
accounting across resumes; and (3) repeat the matched comparison or add an
official raw-session/full-history arm if the intended claim concerns NMG versus
another memory representation rather than NMG versus no retrieved evidence.
