"""Polarity/confidence extraction prototype (qualitative experiment).

Pipeline over a COPY of an NMG benchmark DB:
1. Regex cue filter over memory_records.statement (negation cues).
2. Cue-hit records + their top-k embedding neighbors go to DeepSeek
   (deepseek-chat, temp 0) which returns polarity, a normalized
   predicate_key, and a confidence score.
3. Results are written back into the new confidence/polarity/predicate_key
   columns of the DB copy.

Usage:
  set -a; source .env; set +a
  .benchmarks/omni-venv/Scripts/python.exe evals/omnimemeval/polarity-extract.py \
      --db .benchmarks/polarity-experiment.sqlite
"""

import argparse
import json
import os
import re
import sqlite3
import struct
import sys
import time

import requests

CUE_RE = re.compile(
    r"\b(never|no|not|n't|haven't|hasn't|hadn't|didn't|don't|doesn't|"
    r"won't|can't|couldn't|without|none|nobody|nothing|neither|nor|"
    r"quit|stopped|gave up|rarely|hardly|barely|seldom)\b"
    r"|[\u6ca1\u6709\u4ece\u4e0d\u522b\u672a\u514d\u5426]",
    re.IGNORECASE,
)

PROMPT = """You are a logic-normalization extractor. Given one memory statement, output JSON only:
{
  "polarity": "affirmative" | "negative",
  "predicate_key": "<snake_case English canonical predicate, subject+verb+object, no negation words, e.g. 'user_written_flask_routes'>",
  "confidence": <float 0..1, how certain the statement asserts this predicate>
}
Rules:
- The speaker is the name before the leading colon (e.g. "Jon: ..." -> subject 'jon'). Use the SPEAKER as predicate subject unless the statement is explicitly about the other person.
- polarity is "negative" ONLY when the speaker denies a concrete fact about themselves/the world (never did X, no longer Y, didn't Z). Questions, idioms ("can't deny that view"), and figures of speech are "affirmative" with low confidence.
- predicate_key must be IDENTICAL for a statement and its negation (strip negation).
- confidence = how strongly the statement asserts a concrete, checkable fact (small talk / questions / encouragement -> 0.3 or below).
Statement: %s
JSON:"""


def load_vec(row):
    blob = row["vector_blob"]
    if blob:
        n = len(blob) // 4
        return list(struct.unpack(f"<{n}f", blob))
    return json.loads(row["vector_json"])


def cosine(a, b):
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    return dot / ((na ** 0.5) * (nb ** 0.5) + 1e-12)


def extract(client_key, statement, retries=3):
    for attempt in range(retries):
        try:
            r = requests.post(
                "https://api.deepseek.com/chat/completions",
                headers={"Authorization": f"Bearer {client_key}"},
                json={
                    "model": "deepseek-chat",
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "messages": [{"role": "user", "content": PROMPT % statement}],
                },
                timeout=60,
            )
            r.raise_for_status()
            data = json.loads(r.json()["choices"][0]["message"]["content"])
            pol = data.get("polarity")
            if pol not in ("affirmative", "negative"):
                pol = None
            key = data.get("predicate_key")
            conf = data.get("confidence")
            return pol, (str(key).strip() if key else None), (float(conf) if conf is not None else None)
        except Exception as e:
            if attempt == retries - 1:
                print(f"  !! extract failed: {e}", file=sys.stderr)
                return None, None, None
            time.sleep(2 * (attempt + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--neighbors", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="max cue records (0=all)")
    args = ap.parse_args()

    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        sys.exit("DEEPSEEK_API_KEY not set")

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "SELECT id, statement, source_actor FROM memory_records WHERE status='active'"
    ).fetchall()
    vecs = {
        r["memory_id"]: load_vec(r)
        for r in db.execute("SELECT memory_id, vector_json, vector_blob FROM memory_embeddings")
    }
    print(f"{len(rows)} active records, {len(vecs)} embeddings")

    cue_rows = [r for r in rows if CUE_RE.search(r["statement"])]
    if args.limit:
        cue_rows = cue_rows[: args.limit]
    print(f"{len(cue_rows)} cue-hit records")

    # candidates: cue records + top-k embedding neighbors of each cue record
    cand = {}
    for r in cue_rows:
        cand[r["id"]] = r
        v = vecs.get(r["id"])
        if not v:
            continue
        sims = sorted(
            ((cosine(v, ov), oid) for oid, ov in vecs.items() if oid != r["id"]),
            reverse=True,
        )[: args.neighbors]
        for sim, oid in sims:
            if oid not in cand:
                row = next((x for x in rows if x["id"] == oid), None)
                if row:
                    cand[oid] = row
    print(f"{len(cand)} candidate records to extract (cues + neighbors)")

    upd = db.cursor()
    done = 0
    for rid, row in cand.items():
        pol, pkey, conf = extract(key, row["statement"])
        upd.execute(
            "UPDATE memory_records SET polarity=?, predicate_key=?, confidence=? WHERE id=?",
            (pol, pkey, conf, rid),
        )
        done += 1
        if done % 20 == 0:
            db.commit()
            print(f"  {done}/{len(cand)}")
    db.commit()

    n_neg = db.execute("SELECT COUNT(*) FROM memory_records WHERE polarity='negative'").fetchone()[0]
    n_key = db.execute("SELECT COUNT(*) FROM memory_records WHERE predicate_key IS NOT NULL").fetchone()[0]
    print(f"done: {done} extracted, {n_neg} negative, {n_key} with predicate_key")
    db.close()


if __name__ == "__main__":
    main()
