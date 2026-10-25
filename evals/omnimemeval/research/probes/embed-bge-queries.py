"""Encode every LoCoMo question, all categories, with the bge-en query prefix.

The earlier probes only ever ran multi-hop questions, so their query vector file
contains 282 entries and any other category silently produced no rows. This script
encodes the whole question set once so every probe can be re-run on the full
corpus without touching the store or the document vectors.

    python embed-bge-queries.py --data <locomo10.json> --out <dir>
"""

import argparse
import json
import os

import numpy as np
from sentence_transformers import SentenceTransformer

QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    return parser.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    model = SentenceTransformer(args.model)
    dataset = json.load(open(args.data, encoding="utf-8"))

    keys = []
    counts = {}
    for sample in dataset:
        for qa in sample.get("qa", []):
            question = str(qa.get("question", "")).strip()
            if not question:
                continue
            keys.append(f"{sample['sample_id']}\u0000{question}")
            category = int(qa.get("category", -1))
            counts[category] = counts.get(category, 0) + 1

    unique = list(dict.fromkeys(keys))
    texts = [QUERY_PREFIX + key.split("\u0000", 1)[1] for key in unique]
    vectors = model.encode(
        texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False
    )
    with open(os.path.join(args.out, "queries.ids.json"), "w", encoding="utf-8") as handle:
        json.dump(unique, handle)
    np.asarray(vectors, dtype=np.float32).tofile(os.path.join(args.out, "queries.vecs.f32"))
    print(f"questions: {len(unique)}  by category: {json.dumps(counts, sort_keys=True)}")


if __name__ == "__main__":
    main()
