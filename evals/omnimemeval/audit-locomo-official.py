"""LoCoMo official search-only evidence audit (README method, record-count fixed).

The rendered context may omit the [timestamp] prefix (only temporal queries get
it), so record counting must not rely on '\n['. Evidence matching is exact
normalized substring on the full context.
"""
import json
import re
import statistics
import sys

RESULTS = sys.argv[1] if len(sys.argv) > 1 else r".benchmarks/official/OmniMemEval/results/locomo/nmg-adaptive13_bge_20260802/nmg_locomo_search_results.json"
DATA = sys.argv[2] if len(sys.argv) > 2 else r".benchmarks/official/OmniMemEval/data/locomo/locomo10.json"

def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()

def count_records(ctx: str) -> int:
    n = 0
    for ln in ctx.split("\n"):
        s = ln.strip()
        if re.match(r"^(\[\d{4}-|\w+:) ", s) and "NMG retrieval" not in s and "Memories for user" not in s:
            n += 1
    return n

results = json.load(open(RESULTS, encoding="utf-8"))
locomo = json.load(open(DATA, encoding="utf-8"))

samples = []
for conv in locomo:
    turns = {}
    for session_key, session in conv.get("conversation", {}).items():
        if not isinstance(session, list):
            continue
        for turn in session:
            dia = turn.get("dia_id")
            if dia and turn.get("text"):
                turns[dia] = norm(turn["text"])
    samples.append({"turns": turns, "qa": conv.get("qa", [])})

total = any_hit = all_hit = label_hits = label_total = 0
chars_all, recs_all = [], []
for user_key, questions in results.items():
    idx = int(user_key.rsplit("_", 1)[1])
    sample = samples[idx]
    turns = sample["turns"]
    for q in questions:
        if q.get("status") != "success":
            continue
        ctx = q.get("context", "")
        nctx = norm(ctx)
        chars_all.append(len(ctx))
        recs_all.append(count_records(ctx))
        qa = next((item for item in sample["qa"] if norm(item.get("question", "")) == norm(q.get("query", ""))), None)
        if qa is None or not qa.get("evidence"):
            continue
        total += 1
        found = sum(1 for dia in qa["evidence"] if norm(turns.get(dia, "")) in nctx)
        label_hits += found
        label_total += len(qa["evidence"])
        if found > 0:
            any_hit += 1
        if found == len(qa["evidence"]):
            all_hit += 1

print(f"questions with labelled evidence: {total}")
print(f"  any evidence: {any_hit}/{total} ({100*any_hit/total:.1f}%)")
print(f"  all evidence: {all_hit}/{total} ({100*all_hit/total:.1f}%)")
print(f"  overall recall: {label_hits}/{label_total} ({100*label_hits/max(label_total,1):.1f}%)")
print(f"mean records/query: {statistics.mean(recs_all):.1f} | mean context chars: {statistics.mean(chars_all):.0f} | P95 chars: {sorted(chars_all)[int(0.95*len(chars_all))]}")
