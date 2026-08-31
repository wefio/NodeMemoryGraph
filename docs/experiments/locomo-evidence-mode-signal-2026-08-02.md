# LoCoMo evidence-mode signal audit (2026-08-02)

## Question

Can query-independent retrieval signals from the three-route weighted-RRF path
distinguish questions requiring one evidence record from questions requiring
multiple records? Can the same signals predict whether the visible Top-20 is
already evidence-complete?

## Protocol

- Dataset: official OmniMemEval LoCoMo `locomo10.json`.
- Evaluated questions: 1,978 with evidence IDs resolvable to conversation turns.
- Labels: `multi_evidence = unique evidence IDs > 1`; `complete@20 = every evidence
  ID appears in the fused Top-20`.
- Retrieval: BGE-small record vectors; original query, Top-1 reverse lookup, and
  QPP2 reverse lookup; weighted RRF; no label is used during retrieval or feature
  construction.
- Features: Top-1 cosine, Top-1 gap, route support, RRF concentration, QPP2
  Top-1 probability mass, effective candidate count, and local diversity.
- Evaluation: five folds grouped by LoCoMo conversation. No LLM calls.

Run:

```powershell
.benchmarks\omni-venv\Scripts\python.exe `
  evals\omnimemeval\research\audits\audit-evidence-mode-signal.py `
  --data .benchmarks\official\OmniMemEval\data\locomo\locomo10.json `
  --output evals\results\locomo-evidence-mode-signal.json
```

## Results

| Target | Prevalence | AUC | Balanced accuracy |
|---|---:|---:|---:|
| Multi-evidence | 21.44% | 0.513 | 0.509 |
| Complete@20 | 43.88% | 0.665 | 0.617 |

The best individual completeness signal was QPP2 Top-1 probability mass
(AUC 0.655). The best individual multi-evidence signal was effective candidate
count (AUC 0.547), which remains too weak for use as a decision boundary.

## Decision

Do not expose `single` versus `multi` as an asserted NMG prompt signal. The
current score distribution does not identify evidence cardinality. Candidate
count is not evidence count, and route agreement is almost uninformative here.

Retain evidence completeness as a shadow signal. It is strong enough to test a
stable prompt contract such as `completeness=low|uncertain|high`, but not yet
strong enough to stop retrieval or authorize an answer. Calibrate it on held-out
data and measure selective risk before wiring it into the Pi adapter.
