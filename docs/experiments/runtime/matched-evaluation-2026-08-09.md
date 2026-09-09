# Matched LongMemEval backend probe — 2026-08-09

This is a seven-question engineering probe, not a leaderboard result. It uses
one fixed case from each locally sampled LongMemEval category, one repeat,
DeepSeek V4 Flash for answering and judging, and two question-level workers.
The retrieval-sufficiency LLM judge was disabled; answer judging and official
session-ID retrieval metrics remained enabled.

Result: `evals/longmemeval/results/2026-08-09T06-02-44.178Z/report.json`

| Arm | Answer | Official recall-any | Official recall-all | Mean answer latency |
| --- | ---: | ---: | ---: | ---: |
| No memory | 1/7 (14.3%) | n/a | n/a | 3.26 s |
| Flat hybrid | 7/7 (100%) | not recorded in this run | not recorded | 4.09 s |
| NMG Lite | 5/7 (71.4%) | 85.7% | 71.4% | 10.36 s |
| NMG Graph | 5/7 (71.4%) | 100% | 71.4% | 11.16 s |

The sample is too small for a capability ranking. It does establish that the
matched protocol is executable and that NMG adds useful memory over the
no-memory arm. Flat retrieval won this small sample while injecting about 3,003
estimated tokens per question, compared with 1,137 for Lite and 931 for Graph.
NMG's extra latency came predominantly from additional model rounds: mean tool
execution was 104 ms (Lite) and 129 ms (Graph), while model-stream time was
7.34 s and 7.94 s respectively. Local search sections were normally measured in
milliseconds.

The two NMG answer failures are diagnostically different:

- A multi-session clothing-count question retrieved relevant evidence but the
  model interpreted the state/update sequence incorrectly.
- Graph retrieved all officially labelled sessions for a temporal question but
  the model declined to treat conversation dates as event dates. This is an
  answer/reasoning policy failure, not evidence-recall failure.

The first attempt at this run exposed a SQLite expression-depth failure when a
long record produced more than one thousand supersession prefilter terms. The
prefilter is now bounded to 64 selective terms and covered by a 1,500-term
regression test. The successful rerun also exposed false daemon-limit warnings:
old descriptors had PIDs reused by live Pi processes. Daemon counting now
requires an authenticated `hello` response and deduplicates overlapping scan
roots; no daemon remained alive after the run.

Future reports calculate official session recall for flat retrieval as well as
NMG. This run predates that final reporting change, so its flat official cells
remain `null` rather than being reconstructed after the fact.

## Causal controller protocol update — 2026-08-20

`matched` now means a causal controller comparison rather than a logging-only
shadow arm. It requires a frozen, trained controller artifact:

```bash
NMG_CONTROLLER_CANDIDATE_STATE=/path/to/controller-shadow-state.json \
  npm run eval:longmem -- matched 1
```

The deterministic and candidate NMG arms share QPP1/QPP2 mechanics, corpus,
prompt, model, thinking level, and hard budgets. Only the candidate arm receives
the validated controller state. The report records its SHA-256, feature protocol,
training steps, per-arm environment, and runtime `allocate|fold|rerank` actions.
Official scoring derives causal eligibility from those actions; it no longer
trusts a static `controllerAffectsRanking` declaration.

The one-question `6a1eabeb` smoke used the 25-step local candidate and recorded
two actions, one of which changed the retrieval projection. Both NMG arms scored
correctly with the same official retrieval (recall 0.5, NDCG 0.613); candidate
disclosure fell from 3,368 to 981 characters. This is an execution-path check,
not an estimate of controller quality or a leaderboard result.

## Evidence-diverse development comparison — 2026-08-20

The next causal run used the fixed `development-v1` manifest: 14 LongMemEval-S
questions, two from each of seven question categories, one repeat, four
question-level workers, retrieval judging enabled, and the same 25-step frozen
candidate (`sha256:1560273cd79c933a0f733d149ead4e0a328a6279868defe243e4371b4c1441f3`).
All 14 candidate cases recorded at least one ranking-changing controller action.
The run and official score are under
`evals/longmemeval/results/2026-08-20T11-53-32.753Z/`; generated result files are
ignored by Git.

| Arm | Official answer accuracy | Official evidence sufficiency | Mean tool rounds | Mean tokens | Mean end-to-end latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| No memory | 2/14 (14.3%) | n/a | 0.00 | 766 | 4.69 s |
| Deterministic NMG | 9/14 (64.3%) | 9/14 (64.3%) | 2.07 | 17,850 | 9.00 s |
| Frozen candidate NMG | 12/14 (85.7%) | 11/14 (78.6%) | 2.36 | 24,068 | 11.26 s |

The candidate gained three answer wins and no answer losses against deterministic
NMG. Mean official session recall increased from 0.762 to 0.905 and NDCG from
0.769 to 0.858. The diagnostic retrieval-sufficiency judge was more optimistic
(7/14 to 12/14), but promotion uses the official ID-based evidence metric above.
This 14-pair result meets the product gate's minimum case count, but the paired
answer difference is still statistically weak (exact two-sided McNemar p=0.25)
and the manifest is a local development sample, not a leaderboard split.

The gain was not free. Relative to deterministic NMG, mean tokens increased by
34.8%, mean end-to-end latency by 25.2%, and mean tool rounds by 13.8%. Feeding
the official score into `eval:controller` therefore passed the controller-quality
gate but failed the product gate's token and latency bounds. The independent
20-case LoCoMo retrieval gate also failed on recall, leaving eligibility at
`shadow=true`, `active=false`, and `defaultPi=false`. This run closes the missing
gate-sized, evidence-diverse causal engineering comparison; it does not replace
matched natural Pi observations or justify promotion.
