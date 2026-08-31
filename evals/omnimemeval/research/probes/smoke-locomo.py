#!/usr/bin/env python
"""Locomo smoke: feed sample 0's conversation to the NMG bridge, then search
back one golden question. Validates cross-dataset format compatibility with
minimal time/cost before launching the full eval in the background."""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
)
DATA = os.path.join(ROOT, ".benchmarks/official/OmniMemEval/data/locomo/locomo10.json")

sample = json.load(open(DATA, encoding="utf-8"))[0]
conv = sample["conversation"]
qa = sample["qa"]

# conversation: {speaker_a, speaker_b, session_1_date_time, session_1, session_2...}
turns = []
for key in sorted(conv.keys()):
    if key.startswith("session_") and not key.endswith("_date_time"):
        date_key = f"{key}_date_time"
        date = conv.get(date_key)
        for utt in conv[key]:
            speaker = utt.get("speaker")
            text = utt.get("text") or utt.get("utterance") or ""
            turns.append(
                {
                    "role": "user" if speaker == conv.get("speaker_a") else "assistant",
                    "content": text,
                    "chat_time": date or None,
                }
            )
print(f"locomo sample 0: {len(turns)} turns, {len(qa)} questions")

bridge = os.path.join(ROOT, "evals/omnimemeval/bridge.ts")
proc = subprocess.Popen(
    ["node", "--experimental-strip-types", bridge],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
    encoding="utf-8",
)

def call(req):
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line)

# Ingest a slice of the conversation (first 40 turns) into a smoke user.
slice_size = 40
call({"id": 1, "op": "add", "userId": "locomo-smoke", "messages": turns[:slice_size]})
print(f"ingested {slice_size} turns")

# Search for 3 golden questions.
hits = 0
for i, q in enumerate(qa[:3]):
    res = call({"id": 2 + i, "op": "search", "userId": "locomo-smoke", "query": q["question"], "topK": 5})
    result = res.get("result", {})
    raw = result.get("memories", []) if isinstance(result, dict) else []
    ok = len(raw) > 0
    if ok:
        hits += 1
    print(f"Q{i + 1}: {'HIT' if ok else 'miss'} ({len(raw)} results) :: {q['question'][:50]}")
call({"id": 99, "op": "close"})
proc.wait(timeout=30)
print(f"smoke: {hits}/3 golden questions retrieved")
sys.exit(0 if hits >= 2 else 1)
