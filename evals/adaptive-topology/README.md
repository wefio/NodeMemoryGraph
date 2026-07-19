# Adaptive topology ablation

Run the deterministic held-out relation and routing experiment:

```powershell
npm run eval:adaptive
```

Each case creates two semantically orthogonal nodes. The query identifies only
the entry node while the required evidence lives in the other node. The
experiment compares flat retrieval, a fixed unlinked graph, and an accepted
co-retrieval proposal. It also compares the heuristic router before labels with
the existing framework-independent online router after explicit useful-node
labels.

The command fails unless adaptive graph recall improves over the fixed graph,
labelled routing improves over the heuristic route, and proposal precision is
100% on the controlled workload. This is a mechanism/ablation test, not a claim
about natural conversation quality.

The 2026-07-19 local 30-case run produced flat/fixed/adaptive recall of
0%/0%/100%, heuristic/labelled routing accuracy of 0%/100%, and 100% proposal
precision. P50 retrieval latency was approximately 0.36/0.78/1.10 ms. The
extreme separation is intentional: each held-out case requires exactly the
relation supplied by repeated useful co-retrieval labels.
