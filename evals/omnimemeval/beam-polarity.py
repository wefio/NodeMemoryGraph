"""Polarity extraction over raw BEAM messages (no NMG DB needed).

Reads the first conversation (NDJSON line 1) of beam_100k.json, runs the same
DeepSeek extraction as polarity-extract.py on every message, and reports
contradiction pairs (same predicate_key, opposite polarity). The known pair:
msg-58 "I've never written any Flask routes..." vs msg-24 "...implement the
basic homepage route with Flask" must collide on one predicate_key.

Usage:
  set -a; source .env; set +a
  .benchmarks/omni-venv/Scripts/python.exe evals/omnimemeval/beam-polarity.py
"""

import json
import os
import sys

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "polarity_extract",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "polarity-extract.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
extract = _mod.extract

# chats is a junction into .benchmarks/official/BEAM/chats (native BEAM repo data)
DATA = ".benchmarks/official/OmniMemEval/data/beam/chats/100K/1/chat.json"
OUT = ".benchmarks/beam-conv1-polarity.json"


def load_messages(path):
    """Flatten native BEAM chat.json (batches -> turns -> messages)."""
    batches = json.load(open(path, encoding="utf-8"))
    msgs = []
    for b in batches:
        for turn in b["turns"]:
            msgs.extend(turn)
    return msgs


def main():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        sys.exit("DEEPSEEK_API_KEY not set")

    msgs = load_messages(DATA)
    print(f"{len(msgs)} messages in conversation 1")

    results = {}
    if os.path.exists(OUT):
        results = {r["id"]: r for r in json.load(open(OUT, encoding="utf-8"))}
        print(f"resuming: {len(results)} already extracted")

    for i, m in enumerate(msgs):
        mid = m.get("id", f"msg-{i}")
        if mid in results:
            continue
        text = f"{m.get('role', '?')}: {m.get('content', m.get('text', ''))}"
        pol, pkey, conf = extract(key, text)
        results[mid] = {"id": mid, "polarity": pol, "predicate_key": pkey,
                        "confidence": conf, "text": text}
        if len(results) % 20 == 0:
            json.dump(list(results.values()), open(OUT, "w", encoding="utf-8"), indent=1)
            print(f"  {len(results)}/{len(msgs)}")
    json.dump(list(results.values()), open(OUT, "w", encoding="utf-8"), indent=1)

    by_key = {}
    for r in results.values():
        if r["predicate_key"]:
            by_key.setdefault(r["predicate_key"], []).append(r)

    # Second pass: canonicalize keys via embedding clustering. DeepSeek cannot
    # produce identical keys across paraphrases ("implemented homepage route
    # with flask" vs "written flask routes"), so merge keys whose embeddings
    # are near-identical (cosine >= THRESH).
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    from sentence_transformers import SentenceTransformer

    THRESH = 0.85
    keys = sorted(by_key)
    model = SentenceTransformer("BAAI/bge-small-en-v1.5")
    emb = model.encode(keys, normalize_embeddings=True)
    parent = list(range(len(keys)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            if float(emb[i] @ emb[j]) >= THRESH:
                parent[find(j)] = find(i)
    canon = {}
    for i, k in enumerate(keys):
        canon.setdefault(find(i), []).append(k)
    merged = {min(members, key=lambda k: -len(by_key[k])): members
              for members in canon.values() if len(members) > 1}
    print(f"\n{len(keys)} raw keys -> {len(canon)} clusters; merges:")
    for rep, members in merged.items():
        print(f"  {rep}  <=  {members}")
    for r in results.values():
        k = r["predicate_key"]
        if k:
            for rep, members in merged.items():
                if k in members:
                    r["predicate_key"] = rep
                    break
    by_key = {}
    for r in results.values():
        if r["predicate_key"]:
            by_key.setdefault(r["predicate_key"], []).append(r)

    pairs = 0
    for k, rs in sorted(by_key.items()):
        pols = {r["polarity"] for r in rs}
        if "affirmative" in pols and "negative" in pols:
            pairs += 1
            print(f"\n== CONTRADICTION {k}")
            for r in rs:
                print(f"  [{r['id']} {r['polarity'][:3]} {r['confidence']}] {r['text'][:110]}")
    print(f"\n{pairs} contradiction pairs; "
          f"{sum(1 for r in results.values() if r['polarity'] == 'negative')} negative messages")

    # the known pair, explicitly (native BEAM message ids)
    for mid in (24, 58, 66):
        r = results.get(mid)
        if r:
            print(f"KNOWN {mid}: pol={r['polarity']} key={r['predicate_key']} :: {r['text'][:100]}")


if __name__ == "__main__":
    main()
