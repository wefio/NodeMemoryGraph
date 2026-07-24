"""
Phase 1: Load standard public datasets for contrastive pretraining.
Phase 2: Generate contrastive pairs from NMG's existing memory store.

No benchmark data is used at any stage.
"""

import json
import argparse
import sqlite3
import numpy as np
from pathlib import Path
from collections import defaultdict


# ═══════════════════════════════════════════════════════════════════
# Phase 1: Standard datasets
# ═══════════════════════════════════════════════════════════════════

def load_all_nli(output_path: str, max_pairs: int = 200_000):
    """
    Load AllNLI (SNLI + MultiNLI) entailment pairs.
    Each entailment pair → (premise as query, hypothesis as positive).
    Contradiction pairs → hard negatives.

    Requires: pip install datasets
    """
    from datasets import load_dataset

    pairs = []
    for split_name in ["snli", "multi_nli"]:
        try:
            dataset = load_dataset("sentence-transformers/all-nli", split_name, split="train")
        except Exception:
            print(f"  {split_name}: not available, skipping")
            continue

        for item in dataset:
            if len(pairs) >= max_pairs:
                break
            label = item["label"]
            if label == 0:  # entailment
                pairs.append({
                    "query": item["premise"],
                    "positive": item["hypothesis"],
                    "hard_negative": "",
                })
            # Also collect contradiction pairs for hard negative mining
            elif label == 2 and pairs and pairs[-1]["hard_negative"] == "":
                # Pair contradiction with the previous entailment's premise
                pairs[-1]["hard_negative"] = item["hypothesis"]

        print(f"  {split_name}: {len(pairs)} pairs so far")

    # Filter out pairs without hard negatives
    pairs = [p for p in pairs if p["hard_negative"]]

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for p in pairs[:max_pairs]:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    print(f"AllNLI: wrote {min(len(pairs), max_pairs)} pairs to {output_path}")
    return output_path


def load_msmarco(output_path: str, max_pairs: int = 200_000):
    """
    Load MS MARCO passage ranking triples.
    (query, positive_passage, negative_passage) format.
    """
    from datasets import load_dataset

    dataset = load_dataset("sentence-transformers/msmarco-co-condenser-margin-mse", split="train")
    pairs = []

    for item in dataset:
        if len(pairs) >= max_pairs:
            break
        pairs.append({
            "query": item["query"],
            "positive": item["positive"],
            "hard_negative": item.get("negative", ""),
        })

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for p in pairs:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    print(f"MS MARCO: wrote {len(pairs)} pairs to {output_path}")
    return output_path


def load_dureader(output_path: str, max_pairs: int = 50_000):
    """
    Load DuReader retrieval pairs (Chinese).
    Falls back to mMARCO-zh if DuReader is unavailable.
    """
    from datasets import load_dataset

    pairs = []

    # Try DuReader first
    try:
        dataset = load_dataset("dureader", split="train")
        for item in dataset:
            if len(pairs) >= max_pairs:
                break
            if item.get("answers") and len(item["answers"]) > 0:
                pairs.append({
                    "query": item["question"],
                    "positive": item["answers"][0],
                    "hard_negative": "",
                })
    except Exception:
        print("  DuReader not available, trying mMARCO-zh...")
        try:
            dataset = load_dataset("mMARCO-zh", split="train")
            for item in dataset:
                if len(pairs) >= max_pairs:
                    break
                pairs.append({
                    "query": item["query"],
                    "positive": item["positive"],
                    "hard_negative": "",
                })
        except Exception:
            print("  mMARCO-zh also not available, skipping Chinese dataset")

    # Add hard negatives: use next query's positive as negative for current query
    for i in range(len(pairs) - 1):
        if pairs[i]["hard_negative"] == "":
            pairs[i]["hard_negative"] = pairs[(i + 3) % len(pairs)]["positive"]

    pairs = [p for p in pairs if p["hard_negative"]]

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for p in pairs[:max_pairs]:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    print(f"Chinese: wrote {min(len(pairs), max_pairs)} pairs to {output_path}")
    return output_path


# ═══════════════════════════════════════════════════════════════════
# Phase 2: NMG self-supervised pairs
# ═══════════════════════════════════════════════════════════════════

def generate_nmg_pairs(
    db_path: str,
    output_path: str,
    teacher_model: str = "Qwen/Qwen3-Embedding-0.6B",
    pos_threshold: float = 0.85,
    neg_min: float = 0.6,
    neg_max: float = 0.85,
    batch_size: int = 32,
):
    """
    Read all active NMG nodes, encode with Qwen3-0.5B, generate contrastive pairs.

    - positive: node pairs with cos > pos_threshold
    - hard_negative: node pairs with neg_min < cos < neg_max

    Does NOT touch any benchmark. Only uses NMG's own stored memory.
    """
    from sentence_transformers import SentenceTransformer

    # Read nodes from SQLite
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    nodes = conn.execute(
        "SELECT id, canonical_name, summary, kind FROM memory_nodes WHERE status = 'active'"
    ).fetchall()
    conn.close()

    if len(nodes) < 3:
        print(f"NMG has only {len(nodes)} nodes — skipping Phase 2 (need at least 3)")
        return None

    # Build embedding text
    texts = [f"{n['canonical_name']} {n['kind']} {n['summary']}" for n in nodes]
    node_ids = [n["id"] for n in nodes]
    print(f"Encoding {len(texts)} NMG nodes with {teacher_model}...")

    model = SentenceTransformer(teacher_model)
    embeddings = model.encode(texts, batch_size=batch_size, show_progress_bar=True,
                               normalize_embeddings=True)

    # Compute similarity matrix
    sim_matrix = embeddings @ embeddings.T

    # Generate pairs
    pairs = []
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            sim = float(sim_matrix[i][j])
            if sim >= pos_threshold:
                pairs.append({
                    "query": texts[i],
                    "positive": texts[j],
                    "hard_negative": "",
                    "_teacher_score": round(sim, 4),
                    "_node_ids": [node_ids[i], node_ids[j]],
                })
            elif neg_min <= sim < neg_max:
                pairs.append({
                    "query": texts[i],
                    "positive": texts[i],  # self as placeholder positive
                    "hard_negative": texts[j],
                    "_teacher_score": round(sim, 4),
                    "_node_ids": [node_ids[i], node_ids[j]],
                })

    # For each negative pair, find a proper positive
    for p in pairs:
        if p["positive"] == p["query"]:
            # Find the most similar other node as positive
            qi = node_ids.index(p["_node_ids"][0])
            best_sim = -1
            best_idx = -1
            for k in range(len(nodes)):
                if k != qi:
                    s = float(sim_matrix[qi][k])
                    if s > best_sim:
                        best_sim = s
                        best_idx = k
            if best_idx >= 0 and best_sim > pos_threshold:
                p["positive"] = texts[best_idx]
                p["_positive_score"] = round(best_sim, 4)
            else:
                p["positive"] = ""  # will be filtered

    pairs = [p for p in pairs if p["positive"] and p["positive"] != p["query"]]

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for p in pairs:
            # Remove internal fields for training
            clean = {k: v for k, v in p.items() if not k.startswith("_")}
            f.write(json.dumps(clean, ensure_ascii=False) + "\n")

    positive_count = sum(1 for p in pairs if p.get("_teacher_score", 0) >= pos_threshold)
    negative_count = len(pairs) - positive_count
    print(f"NMG pairs: wrote {len(pairs)} pairs ({positive_count} positive, {negative_count} hard_negative) to {output_path}")
    return output_path


def merge_datasets(paths: list[str], output_path: str, shuffle: bool = True):
    """Merge multiple JSONL contrastive pair files into one."""
    all_pairs = []
    for p in paths:
        if p and Path(p).exists():
            with open(p, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        all_pairs.append(line.strip())

    if shuffle:
        import random
        random.shuffle(all_pairs)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for pair in all_pairs:
            f.write(pair + "\n")

    print(f"Merged {len(all_pairs)} pairs to {output_path}")
    return output_path


# ═══════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare training data for MiniMind-NMG Encoder")

    parser.add_argument("--phase", type=int, choices=[1, 2, 0], default=1,
                        help="1=standard datasets, 2=NMG self-supervised, 0=merge all")
    parser.add_argument("--output_dir", type=str, default="./out/data")
    parser.add_argument("--max_pairs", type=int, default=200_000,
                        help="Max pairs per dataset")
    parser.add_argument("--nmg_db", type=str, default=".nmg/nmg.sqlite",
                        help="Path to NMG SQLite database (Phase 2)")
    parser.add_argument("--teacher_model", type=str, default="Qwen/Qwen3-Embedding-0.6B",
                        help="Teacher model for Phase 2 similarity scoring")

    args = parser.parse_args()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if args.phase == 1:
        paths = []
        paths.append(load_all_nli(str(out / "all_nli.jsonl"), max_pairs=args.max_pairs))
        paths.append(load_msmarco(str(out / "msmarco.jsonl"), max_pairs=args.max_pairs // 2))
        paths.append(load_dureader(str(out / "chinese.jsonl"), max_pairs=args.max_pairs // 4))
        merge_datasets(paths, str(out / "phase1_train.jsonl"))

    elif args.phase == 2:
        generate_nmg_pairs(
            db_path=args.nmg_db,
            output_path=str(out / "phase2_nmg.jsonl"),
            teacher_model=args.teacher_model,
        )

    elif args.phase == 0:  # merge
        phase1 = str(out / "phase1_train.jsonl")
        phase2 = str(out / "phase2_nmg.jsonl")
        existing = [p for p in [phase1, phase2] if Path(p).exists()]
        if existing:
            merge_datasets(existing, str(out / "train.jsonl"))
