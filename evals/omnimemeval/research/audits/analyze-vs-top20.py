"""Compare: fixed top-20 baseline vs proposed "first K + LLM-triggered append".

Baseline: always recommend 20 records, never append.
Proposed: first pass = K (13 default; 1-3 when topGap>5% strong hit),
          agent (oracle) appends to 21 only when evidence is not fully covered
          by the first pass.  Oracle = upper bound on append rate.

Metrics per question (averaged over 1986 LoCoMo questions):
  records used (token proxy), noise records (non-evidence), evidence coverage,
  append rate (oracle: full coverage not reached in first pass).
"""
import json
import statistics

rows = json.load(open("evals/results/elbow-data.json", encoding="utf-8"))

def hits_before(k, r):
    return sum(1 for h in r["hitAt"] if h <= k)

def cov_at(k, r):
    return hits_before(k, r) / max(r["numEvidence"], 1)

def top_gap(r, threshold=0.05):
    """relative top1-top2 margin on vector scores; True when real cliff."""
    s = r["vectorScores"]
    if len(s) < 2 or s[0] <= 0:
        return False
    return (s[0] - s[1]) / s[0] > threshold

FIRST = 13
STRONG = 3
APPEND_TO = 21

stats = {
    "baseline": {"records": [], "noise": [], "cov": []},
    "proposed": {"records": [], "noise": [], "cov": [], "appended": 0, "strong": 0},
}

for r in rows:
    # baseline: fixed 20
    stats["baseline"]["records"].append(20)
    stats["baseline"]["noise"].append(20 - hits_before(20, r))
    stats["baseline"]["cov"].append(cov_at(20, r))

    # proposed: first = 3 (strong hit) or 13; append to 21 if not fully covered
    first = STRONG if top_gap(r) else FIRST
    if top_gap(r):
        stats["proposed"]["strong"] += 1
    if r["kneed100"] > first:  # oracle: not fully covered -> append
        final = APPEND_TO
        stats["proposed"]["appended"] += 1
    else:
        final = first
    stats["proposed"]["records"].append(final)
    stats["proposed"]["noise"].append(final - hits_before(final, r))
    stats["proposed"]["cov"].append(cov_at(final, r))

n = len(rows)

def report(name, s):
    return (
        f"{name:10s} records={statistics.mean(s['records']):6.2f} "
        f"noise={statistics.mean(s['noise']):6.2f} "
        f"cov={statistics.mean(s['cov']):.4f}"
    )

print(f"questions: {n}\n")
print(report("baseline", stats["baseline"]))
print(report("proposed", stats["proposed"]))
print(f"\nproposed: append rate = {100*stats['proposed']['appended']/n:.1f}% (oracle, upper bound)")
print(f"          strong-hit rate = {100*stats['proposed']['strong']/n:.1f}% (first pass = {STRONG})")

b, p = stats["baseline"], stats["proposed"]
print("\n=== deltas (proposed - baseline) ===")
print(f"  records:  {statistics.mean(p['records']) - 20:+.2f}  ({(100*(statistics.mean(p['records'])/20 - 1)):+.1f}%)")
print(f"  noise:    {statistics.mean(p['noise']) - statistics.mean(b['noise']):+.2f}  ({(100*(statistics.mean(p['noise'])/statistics.mean(b['noise']) - 1)):+.1f}%)")
print(f"  coverage: {statistics.mean(p['cov']) - statistics.mean(b['cov']):+.4f}")

# token proxy: also report estimated tokens if we weight by record length
# (records count is the proxy; both schemes use the same record population)
