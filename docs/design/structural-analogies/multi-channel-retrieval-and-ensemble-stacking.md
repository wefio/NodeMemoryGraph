# Multi-channel retrieval = Ensemble Stacking

[简体中文](multi-channel-retrieval-and-ensemble-stacking.zh-CN.md) · [Terms used](multi-channel-retrieval-and-ensemble-stacking.terms.yaml)

**Authority:** [Parent scope](../structural-analogies.md).

## Multi-channel retrieval = Ensemble Stacking

**Current implementation:** `src/core/store/retrieval.ts` — retrieval path; `src/core/store/search-ranking.ts` — `hybridScore`.

**Structure:**

```
NMG                              Stacked Generalization
────────────────────────────────────────────────────────────
FTS5 match → lexicalScore       Base learner 1 → prediction
vector cosine → vectorScore     Base learner 2 → prediction
route score → routeScore        Base learner 3 → prediction
combinedScore =                 Meta-learner:
  weighted_sum(scores)             linear combination of base predictions
```

**Similarities:**
- Several independent signals (base learners) each produce a score.
- A linear combination (meta-learner) produces the final ranking.
- Signals can fail independently (FTS finds nothing; vectors are noisy), making the fusion more robust.

**Differences:**
- In true stacking, the meta-learner is trained on held-out data.
- NMG's combination weights are hard-coded, not learned from data.
- A true ensemble has a diversity measure; NMG has not tested channel independence.

**Similarity to sensor fusion (a special case of the Kalman filter):**
- Multiple noisy sensors each provide an observation.
- Weighted fusion gives higher weight to the more precise sensor.
- If three signals are independent and each has noise variance σ²ᵢ, the optimal weight is proportional to 1/σ²ᵢ.

**Design implication:** If each channel's “noise variance” can be estimated (for example, FTS has low recall on semantically ambiguous queries, meaning high variance), adaptive Kalman-like weights could replace the hard-coded weights.

---
