"""Elbow analysis: does the ranked score cliff predict K_need?

Questions answered:
1. Spearman(K_elbow, K_need100/80) for various elbow definitions
2. Distribution of K_elbow (P25/P50/P75/P90) -> learned tier proposal
3. Coverage at K_elbow vs fixed K (8/13/21)
4. Fraction of queries with no detectable elbow (fallback need)
"""
import json
import math
import statistics

rows = json.load(open("evals/results/elbow-data.json", encoding="utf-8"))
print(f"rows: {len(rows)}")

def spearman(xs, ys):
    def rank(vals):
        idx = sorted(range(len(vals)), key=lambda i: vals[i])
        r = [0] * len(vals)
        for pos, i in enumerate(idx):
            r[i] = pos + 1
        return r
    rx, ry = rank(xs), rank(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    varx = sum((a - mx) ** 2 for a in rx)
    vary = sum((b - my) ** 2 for b in ry)
    return cov / math.sqrt(varx * vary) if varx * vary else 0

def elbow(scores, min_rel_gap=0.0):
    """Position of the largest relative score cliff, or None.
    relative gap_i = (s[i-1] - s[i]) / s[0], measured after position 1.
    Returns 1-based K (e.g. elbow at 3 -> recommend K=3)."""
    if len(scores) < 2:
        return None
    s1 = scores[0]
    if s1 <= 0:
        return None
    best_i, best_gap = None, min_rel_gap * s1
    for i in range(1, len(scores)):
        gap = scores[i - 1] - scores[i]
        if gap > best_gap:
            best_gap = gap
            best_i = i  # 1-based index of the last item before the cliff
    return best_i

# --- 1. correlation of elbow with K_need ---
print("\n=== 1. elbow vs K_need correlation (Spearman) ===")
for thr in [0.0, 0.05, 0.1, 0.15, 0.2]:
    xs, y100, y80 = [], [], []
    for r in rows:
        k = elbow(r["scores"], thr)
        if k is None:
            continue
        xs.append(k)
        y100.append(r["kneed100"])
        y80.append(r["kneed80"])
    n = len(xs)
    if n > 30:
        print(f"  rel-gap>={thr:.2f}: n={n}/{len(rows)} | Spearman(elbow,kneed100)={spearman(xs, y100):+.3f} | Spearman(elbow,kneed80)={spearman(xs, y80):+.3f}")
    else:
        print(f"  rel-gap>={thr:.2f}: n={n} (too few)")

# --- 2. elbow distribution -> learned tiers ---
print("\n=== 2. elbow distribution (rel-gap>=0.1) ===")
elbows = []
for r in rows:
    k = elbow(r["scores"], 0.1)
    if k is not None:
        elbows.append(k)
print(f"  detectable elbows: {len(elbows)}/{len(rows)} ({100*len(elbows)/len(rows):.0f}%)")
if elbows:
    for p in [25, 50, 75, 90, 95]:
        idx = int(math.ceil(p / 100 * len(elbows))) - 1
        print(f"  P{p}: {sorted(elbows)[idx]}")

# --- 3. coverage at recommended K ---
print("\n=== 3. coverage: elbow-recommendation vs fixed K ===")
def coverage_at(k, r):
    """fraction of evidence covered in top-k"""
    hits = sum(1 for h in r["hitAt"] if h <= k)
    return hits / max(r["numEvidence"], 1)

for thr in [0.05, 0.1, 0.15]:
    rec_cover, fallback = [], []
    for r in rows:
        k = elbow(r["scores"], thr)
        if k is None:
            fallback.append(coverage_at(13, r))  # fallback policy: fixed 13
            continue
        rec_cover.append(coverage_at(k, r))
    n_rec = len(rec_cover)
    print(f"  thr={thr:.2f}: elbow n={n_rec} | mean cov@elbow={statistics.mean(rec_cover):.3f} | mean elbow K={statistics.mean([elbow(r['scores'],thr) for r in rows if elbow(r['scores'],thr) is not None]):.1f}")
    print(f"          fallback n={len(fallback)} | mean cov@13={statistics.mean(fallback):.3f}")

print("\n  fixed K baselines:")
for k in [8, 13, 21]:
    covs = [coverage_at(k, r) for r in rows]
    print(f"    K={k}: mean cov={statistics.mean(covs):.3f}")

# --- 4. elbow vs kneed100 distance ---
print("\n=== 4. overshoot/undershoot: elbow vs kneed100 ===")
for thr in [0.1]:
    undershoot, overshoot, exact = 0, 0, 0
    for r in rows:
        k = elbow(r["scores"], thr)
        if k is None or r["kneed100"] == 0:
            continue
        if k < r["kneed100"]:
            undershoot += 1
        elif k > r["kneed100"]:
            overshoot += 1
        else:
            exact += 1
    n = undershoot + overshoot + exact
    print(f"  thr={thr}: n={n} | undershoot(elbow<need)={100*undershoot/n:.0f}% | exact={100*exact/n:.0f}% | overshoot={100*overshoot/n:.0f}% | median elbow={statistics.median(elbows)} | median kneed100={statistics.median([r['kneed100'] for r in rows if r['kneed100']>0])}")
