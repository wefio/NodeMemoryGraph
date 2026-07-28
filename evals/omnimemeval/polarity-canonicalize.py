"""LLM-arbitrated predicate_key canonicalization over claims (offline pass).

Design: docs/predicate-key-canonicalization.md, mechanism 2 — now operating
on claims_json (atomic claims) instead of record-level columns.

1. Flatten every record's claims_json into claim-level entries.
2. Candidate key pairs: key-embedding cosine >= THRESH, same subject slug.
   (No polarity guard: arbitration is supervised, and merging keys never
   hides a contradiction — claims keep their own polarity.)
3. Candidates arbitrated by batched LLM calls ("same underlying
   predicate?"), union-find merged, keys remapped inside claims_json and
   the record-level rollup recomputed.
4. Contradiction candidates: claims sharing a canonical key with opposite
   polarities, temporally ordered by (record rowid, claim index) — this
   makes INTRA-record contradictions (one message containing both a claim
   and its denial) visible to the join.
5. Advisory per-pair LLM verification (not a gate: deepseek-chat verdicts
   are prompt-unstable).

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
ARB_PROMPT = """For EACH numbered pair of predicate keys, decide whether they name the SAME underlying predicate (same subject, same action, same object), judging by the keys and the example claims. Synonymous verbs for the same act (implement/write/build) count as SAME.
Reply with a JSON array only: [{"pair": <n>, "same": true|false}, ...]
%s"""

VERIFY_PROMPT = """Do these two claims CONTRADICT each other? They share a predicate; one affirms and the other denies the same fact (having done something vs never having done it counts). Sharing only a topic, or a problem report vs a how-to, is NOT a contradiction.
Claim A (earlier): "%s"
Claim B (later): "%s"
Reply JSON only: {"contradiction": true|false}"""


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


def load_claims(db):
    """Flatten claims_json -> list of dicts with record position."""
    out = []
    for rid, rowid, stmt, cj in db.execute(
        "SELECT id, rowid, statement, claims_json FROM memory_records "
        "WHERE claims_json IS NOT NULL ORDER BY rowid"
    ):
        for cidx, c in enumerate(json.loads(cj)):
            if c.get("predicate_key"):
                out.append({
                    "rid": rid, "rowid": rowid, "cidx": cidx,
                    "statement": stmt, "text": c.get("text") or stmt,
                    "polarity": c.get("polarity"), "key": c["predicate_key"],
                })
    return out


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
    claims = load_claims(db)
    pol_of, ex_of, freq = {}, {}, {}
    for c in claims:
        pol_of.setdefault(c["key"], set()).add(c["polarity"])
        ex_of.setdefault(c["key"], c["text"])
        freq[c["key"]] = freq.get(c["key"], 0) + 1
    keys = sorted(pol_of)
    print(f"{len(keys)} distinct keys from {len(claims)} claims")

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
            cands.append(
                ((keys[i], pol_of[keys[i]], ex_of[keys[i]]),
                 (keys[j], pol_of[keys[j]], ex_of[keys[j]]))
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

    for c in claims:
        c["canon"] = rep_of.get(c["key"], c["key"])

    if not args.dry_run and changed:
        cur = db.cursor()
        for rid, cj in db.execute(
            "SELECT id, claims_json FROM memory_records WHERE claims_json IS NOT NULL"
        ):
            arr = json.loads(cj)
            dirty = False
            for c in arr:
                k = c.get("predicate_key")
                if k in changed:
                    c["predicate_key"] = changed[k]
                    dirty = True
            if dirty:
                # recompute record rollup: first non-neutral claim
                pol = key = conf = None
                for c in arr:
                    if c.get("polarity") in ("affirmative", "negative"):
                        pol, key, conf = c["polarity"], c.get("predicate_key"), c.get("confidence")
                        break
                if pol is None and arr:
                    pol, key, conf = arr[0].get("polarity"), arr[0].get("predicate_key"), arr[0].get("confidence")
                cur.execute(
                    "UPDATE memory_records SET claims_json=?, polarity=?, "
                    "predicate_key=?, confidence=? WHERE id=?",
                    (json.dumps(arr, ensure_ascii=False), pol, key, conf, rid),
                )
        db.commit()
        print("db updated")

    # Contradiction candidates: same canonical key, opposite polarity,
    # temporally ordered by (record rowid, claim index).
    by_key = {}
    for c in claims:
        by_key.setdefault(c["canon"], []).append(c)
    pairs = []
    for k, cs in sorted(by_key.items()):
        aff = [c for c in cs if c["polarity"] == "affirmative"]
        neg = [c for c in cs if c["polarity"] == "negative"]
        for a in aff:
            for b_ in neg:
                if (a["rowid"], a["cidx"]) < (b_["rowid"], b_["cidx"]):
                    pairs.append((k, a, b_))
    print(f"\n{len(pairs)} contradiction candidates after canonicalization")

    if pairs and not args.dry_run:
        confirmed = set()
        for n, (_, a, b_) in enumerate(pairs, 1):
            try:
                r = requests.post(
                    "https://api.deepseek.com/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": "deepseek-chat",
                        "temperature": 0,
                        "response_format": {"type": "json_object"},
                        "messages": [{"role": "user", "content": VERIFY_PROMPT % (a["text"][:400], b_["text"][:400])}],
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
        for n, (k, a, b_) in enumerate(pairs, 1):
            mark = "verified" if n in confirmed else "candidate"
            scope = "INTRA-record" if a["rid"] == b_["rid"] else "cross-record"
            print(f"== [{mark} {scope}] {k}\n"
                  f"  [+] {a['text'][:100]}\n"
                  f"  [-] {b_['text'][:100]}")
    db.close()


if __name__ == "__main__":
    main()
