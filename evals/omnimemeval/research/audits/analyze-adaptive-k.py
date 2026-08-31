"""Adaptive-k (megagonlabs, arXiv 2506.08479) simulation on LoCoMo elbow data.

optimal_k = argmax(gaps) + buffer (default 5) + min 1-3 + top-90% cap.
Compare vs pure elbow (no buffer) and fixed K on evidence coverage / cost.
"""
import json
import statistics

rows = json.load(open("evals/results/elbow-data.json", encoding="utf-8"))

def adaptive_k(scores, buffer=5, min_k=1, max_k=34, top90=True, relative=False):
    """Return recommended k per Adaptive-k."""
    if len(scores) < 2:
        return min_k
    s1 = scores[0]
    best_i, best_gap = 0, -1.0
    for i in range(1, len(scores)):
        gap = (scores[i - 1] - scores[i]) / s1 if relative else scores[i - 1] - scores[i]
        if gap > best_gap:
            best_gap = gap
            best_i = i  # 1-based position of the last item before the cliff
    k = best_i + buffer
    k = max(k, min_k)
    k = min(k, max_k)
    if top90:
        k = min(k, max(1, int(0.9 * len(scores))))
    return k

def coverage_at(k, r):
    hits = sum(1 for h in r["hitAt"] if h <= k)
    return hits / max(r["numEvidence"], 1)

def evaluate(name, rows, scorer):
    covs, ks = [], []
    for r in rows:
        k = scorer(r)
        ks.append(k)
        covs.append(coverage_at(k, r))
    n = len(rows)
    # oracle check: how often recommended k >= kneed100 (full coverage possible)
    full = sum(1 for r, k in zip(rows, ks) if r["kneed100"] > 0 and k >= r["kneed100"])
    need_gt0 = sum(1 for r in rows if r["kneed100"] > 0)
    print(f"  {name:40s} mean_k={statistics.mean(ks):6.2f}  cov={statistics.mean(covs):.4f}  full_cov_rate={full}/{need_gt0} ({100*full/max(need_gt0,1):.0f}%)")

print(f"rows: {len(rows)}\n")

# --- baselines: fixed K ---
for k in [8, 13, 21]:
    evaluate(f"fixed K={k}", rows, lambda r, k=k: k)

print("\n--- pure elbow (no buffer, min 1) ---")
for rel in [False, True]:
    evaluate(f"elbow abs-gap, min1 (rel={rel})", rows, lambda r, rel=rel: adaptive_k(r["vectorScores"] if rel else r["scores"], buffer=0, min_k=1, top90=False, relative=rel))

print("\n--- Adaptive-k full (paper: abs gap + buffer 5 + min1 + top90) ---")
evaluate("Adaptive-k scores, buffer5, min1, top90", rows, lambda r: adaptive_k(r["scores"], buffer=5, min_k=1, top90=True, relative=False))
evaluate("Adaptive-k vector, buffer5, min1, top90", rows, lambda r: adaptive_k(r["vectorScores"], buffer=5, min_k=1, top90=True, relative=False))

print("\n--- Adaptive-k variants (vector scores) ---")
for buf in [3, 5, 8]:
    for min_k in [1, 3]:
        evaluate(f"Adaptive-k vector buf={buf} min={min_k} top90", rows, lambda r, b=buf, m=min_k: adaptive_k(r["vectorScores"], buffer=b, min_k=m, top90=True, relative=False))

print("\n--- no top90 cap ---")
evaluate("Adaptive-k vector buf5 min1 (no cap)", rows, lambda r: adaptive_k(r["vectorScores"], buffer=5, min_k=1, top90=False, relative=False))
evaluate("Adaptive-k vector buf5 min3 (no cap)", rows, lambda r: adaptive_k(r["vectorScores"], buffer=5, min_k=3, top90=False, relative=False))
