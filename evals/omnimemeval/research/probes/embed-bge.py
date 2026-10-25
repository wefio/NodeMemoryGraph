"""Encode LoCoMo store statements and multi-hop questions with BGE-small-en-v1.5.

Mirrors NMG's `bge-en` profile: documents use the raw text, queries get the
"Represent this sentence for searching relevant passages: " prefix.

Writes, for each store, `<stem>.ids.json` (record ids in ingest order) and
`<stem>.vecs.f32` (raw little-endian float32 matrix), plus the same pair for the
questions under `queries.*`. The JavaScript probes read those directly, so 5,879
x 384 floats never go through a JSON parser.

    python embed-bge.py --stores <omnimemeval-nmg dir> --data <locomo10.json> --out <dir>
"""

import argparse
import json
import os
import sqlite3

import numpy as np
from sentence_transformers import SentenceTransformer

QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

# The ten LoCoMo conversations, matched to their benchmark store by exact turn
# text. Documented here because the store filenames are content hashes.
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stores", required=True, help="directory holding the per-conversation sqlite stores")
    parser.add_argument("--data", required=True, help="locomo10.json")
    parser.add_argument("--out", required=True, help="output directory for the vector files")
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    model = SentenceTransformer(args.model)
    print("device:", model.device, "dims:", model.get_sentence_embedding_dimension())

    for sample, file in STORES.items():
        conn = sqlite3.connect(
            f"file:{os.path.join(args.stores, file)}?mode=ro", uri=True
        )
        rows = conn.execute(
            "SELECT id, statement FROM memory_records ORDER BY node_id, created_at, rowid"
        ).fetchall()
        conn.close()
        ids = [row[0] for row in rows]
        texts = [row[1] for row in rows]
        vectors = model.encode(
            texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False
        )
        stem = os.path.join(args.out, file.replace(".sqlite", ""))
        with open(stem + ".ids.json", "w", encoding="utf-8") as handle:
            json.dump(ids, handle)
        np.asarray(vectors, dtype=np.float32).tofile(stem + ".vecs.f32")
        print(f"{sample}: {len(ids)} documents")

    dataset = json.load(open(args.data, encoding="utf-8"))
    questions = []
    for sample in dataset:
        for qa in sample.get("qa", []):
            if int(qa.get("category", -1)) != 1:
                continue
            questions.append(f"{sample['sample_id']}\u0000{qa['question']}")
    unique = list(dict.fromkeys(questions))
    texts = [QUERY_PREFIX + item.split("\u0000", 1)[1] for item in unique]
    vectors = model.encode(
        texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False
    )
    with open(os.path.join(args.out, "queries.ids.json"), "w", encoding="utf-8") as handle:
        json.dump(unique, handle)
    np.asarray(vectors, dtype=np.float32).tofile(
        os.path.join(args.out, "queries.vecs.f32")
    )
    print(f"queries: {len(unique)}")


if __name__ == "__main__":
    main()
