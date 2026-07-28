"""Qualitative answer-stage probe: does a contradiction annotation in the
retrieved context make the fixed weak reader (deepseek-chat, temp 0)
answer like BEAM's official ideal_answer?

For each contradiction_resolution question of BEAM conv 1:
  A) baseline: question + the raw statements containing the pair claims
  B) annotated: same statements + an explicit contradiction note derived
     from the claims metadata (no LLM involved in producing the note)

Usage:
  set -a; source .env; set +a
  .benchmarks/omni-venv/Scripts/python.exe evals/omnimemeval/beam-answer-probe.py
"""

import json
import os
import sqlite3
import sys

import requests

sys.stdout.reconfigure(errors="replace")

DB = ".benchmarks/beam-conv1-nmg.sqlite"
QUESTIONS = [
    "Have I worked with Flask routes and handled HTTP requests in this project?",
    "Have I integrated Flask-Login for session management in my project?",
]

READER_PROMPT = """You are answering a user's question using only the retrieved memories below.
Question: %s
Memories:
%s
Answer:"""


def find_pairs(db):
    """Recompute the claim-level contradiction join (post-canonicalization)."""
    claims = []
    for rid, rowid, stmt, cj in db.execute(
        "SELECT id, rowid, statement, claims_json FROM memory_records "
        "WHERE claims_json IS NOT NULL ORDER BY rowid"
    ):
        for cidx, c in enumerate(json.loads(cj)):
            if c.get("predicate_key"):
                claims.append({"rid": rid, "rowid": rowid, "cidx": cidx,
                               "statement": stmt, "text": c.get("text") or stmt,
                               "polarity": c.get("polarity"), "key": c["predicate_key"]})
    by_key = {}
    for c in claims:
        by_key.setdefault(c["key"], []).append(c)
    pairs = []
    for k, cs in by_key.items():
        aff = [c for c in cs if c["polarity"] == "affirmative"]
        neg = [c for c in cs if c["polarity"] == "negative"]
        for a in aff:
            for b in neg:
                if (a["rowid"], a["cidx"]) < (b["rowid"], b["cidx"]):
                    pairs.append((k, a, b))
    return pairs


def pick_evidence(pairs, needle):
    """Statements of records involved in pairs whose claims mention needle."""
    out = {}
    for k, a, b in pairs:
        if needle in k or needle in (a["text"] + b["text"]).lower():
            for c in (a, b):
                out[c["rid"]] = (c["statement"], a["text"], b["text"], k)
    return out


def ask(api_key, prompt):
    r = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": "deepseek-chat", "temperature": 0,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def main():
    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        sys.exit("DEEPSEEK_API_KEY not set")
    db = sqlite3.connect(DB)
    pairs = find_pairs(db)

    needles = ["flask_route", "flask-login"]
    for q, needle in zip(QUESTIONS, needles):
        ev = pick_evidence(pairs, needle)
        print("=" * 70)
        print("Q:", q)
        if not ev:
            print("  !! no evidence pair found")
            continue
        memories = "\n".join(f"- {s[:600]}" for s, *_ in list(ev.values())[:4])
        _, atext, btext, key = next(iter(ev.values()))
        note = (f"\n[System note: memory metadata flags a CONTRADICTION on "
                f"'{key}': earlier claim \"{atext}\" vs later claim \"{btext}\". "
                f"Surface this to the user.]")
        for label, extra in (("A baseline", ""), ("B annotated", note)):
            ans = ask(api_key, READER_PROMPT % (q, memories + extra))
            print(f"\n--- {label} ---\n{ans[:500]}")
    db.close()


if __name__ == "__main__":
    main()
