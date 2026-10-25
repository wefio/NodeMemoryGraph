"""Ablation variants of the contextualised retrieval representation.

Arm B gained recall@20, but the bundle mixed three additions. This script encodes
them separately so the gain can be attributed:

    date      [date | session N] + statement
    prev      statement + the previous turn in the same session
    dateprev  both, without the speaker prefix (the stored statement already
              begins with "Speaker: ", so a separate speaker variant would be a
              duplicate rather than an ablation)

Everything else matches embed-bge-context.py: same model, same order, same output
format, so the probes can compare representations record by record.

    python embed-bge-variants.py --stores <dir> --data <locomo10.json> --out <dir>
"""

import argparse
import json
import os
import sqlite3

import numpy as np
from sentence_transformers import SentenceTransformer

STORES = {
    "conv-26": "0d7abe8198f2196bca477fed.sqlite",
    "conv-30": "473a734e4bd5ee879871549b.sqlite",
    "conv-41": "0d57eb5a0d03aadea54ac095.sqlite",
    "conv-42": "21153a2aed6f416b9b564690.sqlite",
    "conv-43": "40929626de08d686a5bd96d5.sqlite",
    "conv-44": "33a9865dc4020729db29f6f8.sqlite",
    "conv-47": "378996f95f0013e562c50830.sqlite",
    "conv-48": "34969029549adf4436e21263.sqlite",
    "conv-49": "0091975cdb0bc7554b6d22c1.sqlite",
    "conv-50": "7b62923acb915892a180156d.sqlite",
}
VARIANTS = ("date", "prev", "dateprev", "datestrict")


def normalise(value):
    return " ".join(str(value or "").lower().split())


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stores", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    return parser.parse_args()


def turn_entries(sample):
    entries = []
    conversation = sample["conversation"]
    session_keys = sorted(
        (key for key in conversation if key.startswith("session_") and not key.endswith("date_time")),
        key=lambda key: int(key.split("_")[1]),
    )
    for key in session_keys:
        turns = conversation.get(key) or []
        date = str(conversation.get(f"{key}_date_time", "")).strip()
        index = int(key.split("_")[1])
        for position, turn in enumerate(turns):
            speaker = str(turn.get("speaker", "")).strip()
            text = str(turn.get("text", "")).strip()
            if not text:
                continue
            previous = turns[position - 1] if position > 0 else None
            entries.append(
                {
                    "full": normalise(f"{speaker}: {text}"),
                    "head": normalise(f"{speaker}: {text}")[:70],
                    "date": f"[{date} | session {index}]",
                    "previous": (
                        f"\nprevious turn — {str(previous.get('speaker', '')).strip()}: "
                        f"{str(previous.get('text', '')).strip()}"
                        if previous is not None
                        else ""
                    ),
                }
            )
    return entries


def render(variant, entry, statement):
    if entry is None:
        return statement
    if variant == "date":
        return f"{entry['date']} {statement}"
    if variant == "datestrict":
        # what a product change would actually add: the date, not the session index
        return f"[{entry['date'].split('|')[0].strip('[] ')}] {statement}"
    if variant == "prev":
        return f"{statement}{entry['previous']}"
    return f"{entry['date']} {statement}{entry['previous']}"


def main():
    args = parse_args()
    model = SentenceTransformer(args.model)
    dataset = {sample["sample_id"]: sample for sample in json.load(open(args.data, encoding="utf-8"))}
    print("device:", model.device)

    for variant in VARIANTS:
        directory = os.path.join(args.out, variant)
        os.makedirs(directory, exist_ok=True)
        for sample_id, file in STORES.items():
            entries = turn_entries(dataset[sample_id])
            conn = sqlite3.connect(f"file:{os.path.join(args.stores, file)}?mode=ro", uri=True)
            rows = conn.execute(
                "SELECT id, statement FROM memory_records ORDER BY node_id, created_at, rowid"
            ).fetchall()
            conn.close()
            texts = []
            matched = 0
            for _record_id, statement in rows:
                target = normalise(statement)
                entry = next(
                    (item for item in entries if item["full"] in target or (item["head"] and item["head"] in target)),
                    None,
                )
                if entry is not None:
                    matched += 1
                texts.append(render(variant, entry, statement))
            vectors = model.encode(
                texts, batch_size=32, normalize_embeddings=True, show_progress_bar=False
            )
            stem = os.path.join(directory, file.replace(".sqlite", ""))
            with open(stem + ".ids.json", "w", encoding="utf-8") as handle:
                json.dump([row[0] for row in rows], handle)
            np.asarray(vectors, dtype=np.float32).tofile(stem + ".vecs.f32")
        print(f"{variant}: encoded {len(STORES)} conversations")


if __name__ == "__main__":
    main()
