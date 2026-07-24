"""Prepare training data from NMG retrieval traces or synthetic contrasts.

Input format (JSONL, one sample per line):
  {"query": "...", "positive": "...", "hard_negative": "..."}

For NMG traces:
  - query: the search query text
  - positive: a node that entered AG and was subsequently used
  - hard_negative: a node with high similarity score that was NOT used

For synthetic augmentation:
  - Generate paraphrases of the same node as positives
  - Use semantically nearby but functionally different nodes as hard negatives
"""

import json
import argparse
from collections import defaultdict


def from_nmg_trace(trace_path: str, output_path: str):
    """
    Convert NMG retrieval trace JSONL to contrastive training pairs.

    Trace format (one line per retrieval):
    {
      "query": "...",
      "candidates": [
        {"nodeId": "...", "text": "...", "similarity": 0.92, "used": true},
        {"nodeId": "...", "text": "...", "similarity": 0.88, "used": false},
        ...
      ]
    }
    """
    samples = []
    with open(trace_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            trace = json.loads(line)
            query = trace["query"]
            candidates = trace["candidates"]

            used = [c for c in candidates if c.get("used")]
            high_score_unused = [
                c for c in candidates
                if not c.get("used") and c.get("similarity", 0) > 0.7
            ]

            for pos in used:
                # Pick a hard negative from high-score unused
                for neg in high_score_unused:
                    samples.append({
                        "query": query,
                        "positive": pos["text"],
                        "hard_negative": neg["text"],
                    })

    with open(output_path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    print(f"Wrote {len(samples)} contrastive pairs to {output_path}")


def from_existing_embeddings(
    embeddings_path: str,
    output_path: str,
    num_hard_negatives: int = 3,
):
    """
    Generate contrastive pairs from an existing embedding index.

    embeddings_path: JSONL with {"text": "...", "embedding": [...]}
    Uses cosine similarity to find positives (highest) and hard negatives (nearby but not top).
    """
    import numpy as np

    records = []
    with open(embeddings_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                r["embedding"] = np.array(r["embedding"], dtype=np.float32)
                records.append(r)

    vectors = np.stack([r["embedding"] for r in records])
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors = vectors / norms.clip(min=1e-8)
    sim_matrix = vectors @ vectors.T

    samples = []
    for i, rec in enumerate(records):
        # Exclude self
        sim_row = sim_matrix[i].copy()
        sim_row[i] = -1.0

        # Top match = positive
        pos_idx = int(np.argmax(sim_row))
        pos_sim = sim_row[pos_idx]

        # Hard negatives: similar but not the top (e.g., rank 5-10)
        ranked = np.argsort(sim_row)[::-1]
        hard_neg_indices = ranked[5 : 5 + num_hard_negatives]

        for neg_idx in hard_neg_indices:
            if sim_row[neg_idx] > 0.5:
                samples.append({
                    "query": rec["text"],
                    "positive": records[pos_idx]["text"],
                    "hard_negative": records[neg_idx]["text"],
                    "_meta": {
                        "pos_similarity": float(pos_sim),
                        "neg_similarity": float(sim_row[neg_idx]),
                    },
                })

    with open(output_path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    print(f"Wrote {len(samples)} contrastive pairs to {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["trace", "embeddings"], required=True)
    parser.add_argument("--input", type=str, required=True)
    parser.add_argument("--output", type=str, required=True)
    args = parser.parse_args()

    if args.mode == "trace":
        from_nmg_trace(args.input, args.output)
    elif args.mode == "embeddings":
        from_existing_embeddings(args.input, args.output)
