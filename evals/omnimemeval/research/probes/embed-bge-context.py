"""Encode a *contextualised* retrieval representation for each LoCoMo record.

Arm B of the reranking route. The production embedding text is
`${canonicalName}: ${statement}` and the FTS text has no speaker, time or
neighbouring turn either, so a record like "last year, and then every week" is
encoded alone. This script builds the text a human would need to understand the
record without guessing:

    [2:32 pm on 29 January, 2023 | session 2] Gina: I started swimming last year.
    previous turn — Jon: When did you take up swimming?

Everything comes from the source dialogue: the speaker and the date are fields of
the dataset, and the previous turn is the adjacent turn in the same session. No
pronoun is resolved and no missing fact is invented; when a record cannot be
matched to a turn, the raw statement is used unchanged.

Writes `<stem>.ids.json` / `<stem>.vecs.f32` / `<stem>.texts.json` next to the raw
vectors so the probes can compare the two representations on the same records.

    python embed-bge-context.py --stores <dir> --data <locomo10.json> --out <dir>
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


def normalise(value):
    return " ".join(str(value or "").lower().split())


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stores", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    return parser.parse_args()


def build_context(sample):
    """Return a list of (match_text, context_text) ordered by session then turn."""
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
            header = f"[{date} | session {index}] {speaker}: {text}"
            if position > 0:
                previous = turns[position - 1]
                previous_text = str(previous.get("text", "")).strip()
                if previous_text:
                    header += (
                        f"\nprevious turn — {str(previous.get('speaker', '')).strip()}: "
                        f"{previous_text}"
                    )
            entries.append(
                (
                    normalise(f"{speaker}: {text}"),
                    normalise(f"{speaker}: {text}")[:70],
                    header,
                )
            )
    return entries


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    model = SentenceTransformer(args.model)
    dataset = {sample["sample_id"]: sample for sample in json.load(open(args.data, encoding="utf-8"))}
    print("device:", model.device)

    for sample_id, file in STORES.items():
        sample = dataset[sample_id]
        entries = build_context(sample)
        conn = sqlite3.connect(f"file:{os.path.join(args.stores, file)}?mode=ro", uri=True)
        rows = conn.execute(
            "SELECT id, statement FROM memory_records ORDER BY node_id, created_at, rowid"
        ).fetchall()
        conn.close()

        texts = []
        matched = 0
        for _record_id, statement in rows:
            target = normalise(statement)
            chosen = None
            for full, head, context in entries:
                if full in target or (head and head in target):
                    chosen = context
                    break
            if chosen is None:
                texts.append(statement)
            else:
                matched += 1
                texts.append(chosen)

        vectors = model.encode(
            texts, batch_size=32, normalize_embeddings=True, show_progress_bar=False
        )
        stem = os.path.join(args.out, file.replace(".sqlite", ""))
        with open(stem + ".ids.json", "w", encoding="utf-8") as handle:
            json.dump([row[0] for row in rows], handle)
        with open(stem + ".texts.json", "w", encoding="utf-8") as handle:
            json.dump(texts, handle)
        np.asarray(vectors, dtype=np.float32).tofile(stem + ".vecs.f32")
        print(f"{sample_id}: {len(rows)} records, {matched} matched to a turn")


if __name__ == "__main__":
    main()
