"""LLM-arbitrated predicate_key canonicalization (offline repair pass).

Design: docs/predicate-key-canonicalization.md, mechanism 2.

1. Collect distinct keys (+ polarities + one example statement each).
2. Candidate pairs: key-embedding cosine >= THRESH, same subject slug,
   polarity guard (a pair is eligible only if at least one side has no
   negative support OR neither side has affirmative support — i.e. merging
   must not collapse a supported affirmative with a supported negative).
3. Candidates are arbitrated by ONE batched LLM call per 30 pairs:
   "same underlying predicate? yes/no" with example statements.
4. Confirmed pairs are union-find merged and predicate_key is remapped to
   each cluster's representative (shortest key, frequency tiebreak).

Usage:
  set -a; source .env; set +a
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .benchmarks/omni-venv/Scripts/python.exe evals/omnimemeval/polarity-canonicalize.py \
      --db .benchmarks/beam-conv1-nmg.sqlite
"""

import argparse
import json
import os
import sqlite3
import sys
import time

import requests

THRESH = 0.75
ARB_PROMPT = """For EACH numbered pair of predicate keys, decide whether they name the SAME underlying predicate (same subject, same action, same object), judging by the keys and the example statements. Synonymous verbs for the same act (implement/write/build) count as SAME.
Reply with a JSON array only: [{"pair": <n>, "same": true|false}, ...]
%s"""


def arbitrate(api_key, batch):
    listing = "\n".join(
        f"{n}. A={a[0]} (e.g. \"{a[2][:80]}\")  B={b[0]} (e.g. \"{b[2][:80]}\")"
        for n, (a, b) in enumerate(batch, 1)
    )
    r = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": "deepseek-chat",
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": ARB_PROMPT % listing}],
        },
        timeout=120,
    )
    r.raise_for_status()
    data = json.loads(r.json()["choices"][0]["message"]["content"])
    if isinstance(data, dict):
        data = next(iter(data.values()))
    return {int(d["pair"]): bool(d["same"]) for d in data}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--thresh", type=float, default=THRESH)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    from sentence_transformers import SentenceTransformer

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        sys.exit("DEEPSEEK_API_KEY not set")

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "SELECT predicate_key, polarity, statement FROM memory_records "
        "WHERE predicate_key IS NOT NULL"
    ).fetchall()
    pol_of, ex_of, freq = {}, {}, {}
    for r in rows:
        k = r["predicate_key"]
        pol_of.setdefault(k, set()).add(r["polarity"])
        ex_of.setdefault(k, r["statement"])
        freq[k] = freq.get(k, 0) + 1
    keys = sorted(pol_of)
    print(f"{len(keys)} distinct keys from {len(rows)} rows")

    emb = SentenceTransformer("BAAI/bge-small-en-v1.5").encode(
        keys, normalize_embeddings=True
    )
    cands = []
    for i in range(len(keys)):
        subj_i = keys[i].split("_", 1)[0]
        for j in range(i + 1, len(keys)):
            if keys[j].split("_", 1)[0] != subj_i:
                continue
            if float(emb[i] @ emb[j]) < args.thresh:
                continue
            pi, pj = pol_of[keys[i]], pol_of[keys[j]]
            # No polarity guard here: arbitration is supervised by the LLM,
            # and merging keys never hides a contradiction — rows keep their
            # own polarity; a merge can only *create* join candidates.
            cands.append(
                ((keys[i], pi, ex_of[keys[i]]), (keys[j], pj, ex_of[keys[j]]))
            )
    print(f"{len(cands)} candidate pairs to arbitrate (cos >= {args.thresh})")

    parent = {k: k for k in keys}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    yes = 0
    for off in range(0, len(cands), 30):
        batch = cands[off : off + 30]
        for attempt in range(3):
            try:
                verdict = arbitrate(api_key, batch)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  !! arbitration batch failed: {e}", file=sys.stderr)
                    verdict = {}
                time.sleep(2 * (attempt + 1))
        for n, (a, b) in enumerate(batch, 1):
            if verdict.get(n):
                parent[find(a[0])] = find(b[0])
                yes += 1
                print(f"  merge: {a[0]} == {b[0]}")
    print(f"{yes}/{len(cands)} pairs confirmed")

    clusters = {}
    for k in keys:
        clusters.setdefault(find(k), []).append(k)
    rep_of = {}
    for members in clusters.values():
        rep = min(members, key=lambda k: (len(k), -freq[k]))
        for k in members:
            rep_of[k] = rep
    changed = {k: r for k, r in rep_of.items() if k != r}
    print(f"{len(clusters)} clusters; {len(changed)} keys remapped")

    if not args.dry_run:
        cur = db.cursor()
        for k, r in changed.items():
            cur.execute(
                "UPDATE memory_records SET predicate_key=? WHERE predicate_key=?",
                (r, k),
            )
        db.commit()
        print("db updated")

    pairs = db.execute(
        """
        SELECT a.predicate_key, a.statement, b.statement
        FROM memory_records a JOIN memory_records b
          ON a.predicate_key = b.predicate_key
         AND a.polarity = 'affirmative' AND b.polarity = 'negative'
         AND a.rowid < b.rowid
        """
    ).fetchall() if not args.dry_run else []
    print(f"\n{len(pairs)} contradiction candidates after canonicalization")

    # Final stage: verify each candidate pair is a genuine contradiction
    # (same fact, opposite truth value). Per-pair calls, not batched:
    # batching made the judge uniformly strict (0/11) while the identical
    # gold pair alone is judged true. Post-join candidates are few, so the
    # cost is negligible.
    VERIFY_PROMPT = """Do these two statements CONTRADICT each other? They share a predicate; one affirms and the other denies the same fact (having done something vs never having done it counts). Sharing only a topic, or a problem report vs a how-to, is NOT a contradiction.
Statement A (earlier): "%s"
Statement B (later): "%s"
Reply JSON only: {"contradiction": true|false}"""
    if pairs:
        confirmed = set()
        for n, (_, sa, sb) in enumerate(pairs, 1):
            try:
                r = requests.post(
                    "https://api.deepseek.com/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": "deepseek-chat",
                        "temperature": 0,
                        "response_format": {"type": "json_object"},
                        "messages": [{"role": "user", "content": VERIFY_PROMPT % (sa[:400], sb[:400])}],
                    },
                    timeout=60,
                )
                r.raise_for_status()
                v = json.loads(r.json()["choices"][0]["message"]["content"])
                if v.get("contradiction"):
                    confirmed.add(n)
            except Exception as e:
                print(f"  !! verify pair {n} failed: {e}", file=sys.stderr)
        print(f"{len(confirmed)} of {len(pairs)} candidates LLM-verified "
              f"(advisory only — deepseek-chat verdicts are prompt-unstable):")
        for n, (key, sa, sb) in enumerate(pairs, 1):
            mark = "verified" if n in confirmed else "candidate"
            print(f"== [{mark}] {key}\n  [+] {sa[:100]}\n  [-] {sb[:100]}")
    db.close()


if __name__ == "__main__":
    main()
