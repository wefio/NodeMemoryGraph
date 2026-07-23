# Differentiable controller evaluation

This experiment isolates retrieval control from answer generation. It uses the
official evidence identifiers supplied by LoCoMo and BEAM and performs no model
API calls.

```bash
npm run eval:controller -- locomo 4
npm run eval:controller -- beam 4
```

For every case, the runner:

1. imports raw benchmark turns into a fresh NMG store;
2. performs one deterministic `searchContext` retrieval;
3. intersects retrieved memories with official evidence IDs;
4. converts the completed trace into the versioned 32-feature protocol;
5. trains on all but the last case in each category;
6. compares deterministic usefulness ordering and learned node ordering on the
   same held-out candidates and Top-N budget.

The report separates candidate recall from ranking recall. This distinction is
essential: the controller cannot recover an evidence item that candidate
generation never returned.

The default-Pi gate requires enough labelled training cases, candidate recall
of at least 0.8, non-degraded recall and precision, and bounded inference cost.
The runner reports the gate but never changes the Pi extension configuration.

## Initial diagnostic run (2026-07-22)

| Dataset | Train/test | Candidate recall | Baseline recall | Learned recall | Learned inference |
|---|---:|---:|---:|---:|---:|
| LoCoMo | 15 / 5 | 0.300 | 0.300 | 0.300 | 0.246 ms |
| BEAM | 9 / 9 | 0.278 | 0.278 | 0.278 | 0.052 ms |

The balanced hard-negative labels removed the first run's ranking regression,
but both runs fail the candidate-recall gate. The current hashing/lexical
candidate generator, rather than differentiable ranking latency, is therefore
the immediate bottleneck. NMG must not enable the learned controller by default
from these results.

A second matched run used the already-running local
`BAAI/bge-small-en-v1.5` service. LoCoMo candidate recall rose from 0.300 to
0.700; learned Top-2 recall rose from the deterministic baseline's 0.400 to
0.700 at about 0.071 ms per query. BEAM candidate recall instead fell to 0.111
on its nine-case held-out split. BGE therefore demonstrates that embedding
quality can unlock the controller, but not that this particular model and
hierarchical candidate policy generalize. It still fails the 0.8 gate and must
remain opt-in.

The BGE LoCoMo preparation embedded each case independently to preserve strict
isolation. Its roughly 47 seconds of preparation is diagnostic overhead, not a
production estimate: a persistent NMG store would index new nodes and leaf
blocks incrementally instead of rebuilding identical conversation histories
for every benchmark question.

Granularity ablation showed why one global vector policy is insufficient:

- increasing hierarchical routing from 5 nodes / 8 leaves to 20 / 50 did not
  change BEAM candidate recall (0.111), so early routing width was not the
  bottleneck on this sample;
- full record vectors raised BEAM candidate recall to 0.426, but encoded 3,582
  texts and took roughly 230 seconds in the deliberately isolated runner;
- a naive record-vector/lexical weighted score reduced LoCoMo recall to 0.300
  and was removed rather than retained as another fallback;
- unioning independently ranked hierarchy and record candidates preserved
  LoCoMo candidate recall at 0.700, while the learned controller raised held-out
  Top-2 recall from 0.200 to 0.700.

The union path is an experiment, not the default. Production evaluation should
reuse one indexed corpus across questions; rebuilding a corpus for every case is
useful for isolation but substantially overstates steady-state indexing cost.
