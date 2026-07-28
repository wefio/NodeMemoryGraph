"""Validate polarity-worker output against the per-message DeepSeek labels
from beam-polarity.py (.benchmarks/beam-conv1-polarity.json).

Reports polarity agreement overall and split by extract_method (rule vs
llm), plus the status of the known BEAM contradiction pair (msg-24 vs
msg-58).
"""

import json
import sqlite3

DB = ".benchmarks/beam-conv1-nmg.sqlite"
LABELS = ".benchmarks/beam-conv1-polarity.json"

db = sqlite3.connect(DB)
rows = db.execute(
    "SELECT statement, polarity, predicate_key, confidence, extract_method "
    "FROM memory_records WHERE extract_method IS NOT NULL"
).fetchall()

labels = json.load(open(LABELS, encoding="utf-8"))
lab_by_text = {}
for r in labels:
    # labels were built as "role: content"; statements are "role: content"
    lab_by_text[r["text"].strip()] = r

agree = {"rule": [0, 0], "llm": [0, 0]}
neutral = {"rule": 0, "llm": 0}
unmatched = 0
for st, pol, key, conf, method in rows:
    if pol == "neutral":
        neutral[method] += 1
        continue
    lab = lab_by_text.get(st.strip())
    if lab is None or lab["polarity"] not in ("affirmative", "negative"):
        unmatched += 1
        continue
    agree[method][1] += 1
    if pol == lab["polarity"]:
        agree[method][0] += 1

for m, (a, n) in agree.items():
    print(f"{m}: polarity agreement {a}/{n} = {a/max(1,n):.1%}, neutral={neutral[m]}")
print(f"unmatched: {unmatched}")

# known pair
for st, pol, key, conf, method in rows:
    if "homepage route" in st or "never written any Flask routes" in st:
        print(f"PAIR [{method} {pol} {key}] {st[:90]}")
db.close()
