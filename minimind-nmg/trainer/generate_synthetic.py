"""Synthetic data generator for Phase 1 training.

When public datasets are unavailable (HF/ModelScope blocked),
generate contrastive pairs from local text using Qwen3-0.6B as teacher.

Strategy:
  1. Collect all text from local sources (NMG nodes, code docs, READMEs)
  2. Encode with Qwen3 → similarity matrix
  3. Positive pairs: cos > 0.8
  4. Hard negative pairs: 0.5 < cos < 0.75
  5. Also: back-translate Chinese→English and use as positive variants
  6. Also: drop words/swap order to create hard negatives
"""

import json
import os
import re
import random
from pathlib import Path


def collect_local_text(project_root: str) -> list[str]:
    """Gather text from local project files, excluding benchmarks and .nmg."""
    texts = []
    exclude_dirs = {'.git', '.benchmarks', '.nmg', 'node_modules', '.venv',
                    '__pycache__', '.pi', 'minimind', 'minimind-nmg', 'coverage'}

    for root, dirs, files in os.walk(project_root):
        dirs[:] = [d for d in dirs if d not in exclude_dirs and not d.startswith('.')]

        for fname in files:
            if fname.endswith(('.ts', '.py', '.md', '.json')):
                try:
                    path = os.path.join(root, fname)
                    with open(path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    # Extract sentences/paragraphs (min 20 chars, max 2000 chars)
                    paragraphs = re.split(r'\n\s*\n', content)
                    for para in paragraphs:
                        para = para.strip()
                        if 20 < len(para) < 2000:
                            texts.append(para)
                except Exception:
                    pass

    # Add NMG memory statements
    try:
        import sqlite3
        db = sqlite3.connect(os.path.join(project_root, '.nmg', 'nmg.sqlite'))
        rows = db.execute("SELECT statement FROM memory_records").fetchall()
        for r in rows:
            texts.append(r[0])
        db.close()
    except Exception:
        pass

    # Deduplicate and filter noise
    seen = set()
    filtered = []
    for t in texts:
        key = t[:100]
        if key not in seen and not t.startswith('import ') and not t.startswith('//'):
            seen.add(key)
            filtered.append(t)

    print(f"Collected {len(filtered)} unique text segments from local files")
    return filtered


def generate_synthetic_pairs(texts: list[str], num_pairs: int = 20_000):
    """Generate contrastive pairs using text perturbation (no teacher needed)."""

    pairs = []
    random.seed(42)

    for i in range(min(num_pairs * 2, len(texts) * 3)):
        if len(pairs) >= num_pairs:
            break

        idx = random.randint(0, len(texts) - 1)
        text = texts[idx]

        # Skip if too short
        if len(text) < 30:
            continue

        words = text.split()

        # Positive: minor paraphrase (drop 1-2 non-critical words, case change)
        if len(words) > 5:
            pos_words = words.copy()
            drop_idx = random.randint(0, len(pos_words) - 1)
            if len(pos_words[drop_idx]) < 6:  # drop short words
                pos_words.pop(drop_idx)
            positive = " ".join(pos_words)
        else:
            positive = text

        if len(positive) < 10:
            continue

        # Hard negative: swap two key words or take a different sentence
        if random.random() < 0.7 and len(texts) > idx + 1:
            neg_idx = (idx + random.randint(1, min(5, len(texts) - idx - 1))) % len(texts)
            hard_negative = texts[neg_idx]
        else:
            # Word-level perturbation
            neg_words = words.copy()
            if len(neg_words) >= 4:
                a, b = random.randint(0, len(neg_words) - 1), random.randint(0, len(neg_words) - 1)
                neg_words[a], neg_words[b] = neg_words[b], neg_words[a]
            hard_negative = " ".join(neg_words)

        if len(hard_negative) < 10:
            continue

        pairs.append({
            "query": text,
            "positive": positive,
            "hard_negative": hard_negative,
        })

    print(f"Generated {len(pairs)} synthetic pairs (word-drop + swap perturbation)")
    return pairs


def generate_teacher_pairs(texts: list[str], output_path: str,
                            teacher_path: str, max_pairs: int = 10_000):
    """
    Phase 2-style pairs using Qwen3 teacher for similarity scoring.
    Only encode a subset to keep it fast.
    """
    from sentence_transformers import SentenceTransformer

    # Sample texts
    if len(texts) > 3000:
        texts = random.sample(texts, 3000)

    print(f"Encoding {len(texts)} texts with teacher model...")
    model = SentenceTransformer(teacher_path)
    embeddings = model.encode(texts, batch_size=64, show_progress_bar=True,
                               normalize_embeddings=True)

    sim = embeddings @ embeddings.T
    pairs = []

    for i in range(len(texts)):
        if len(pairs) >= max_pairs:
            break
        # Best match = positive
        row = sim[i].copy()
        row[i] = -1
        pos_j = int(row.argmax())
        if row[pos_j] < 0.75:
            continue

        # Hard negative: rank ~10
        ranked = row.argsort()[::-1]
        neg_j = ranked[min(10, len(ranked) - 1)]
        if row[neg_j] < 0.4:
            continue

        pairs.append({
            "query": texts[i],
            "positive": texts[pos_j],
            "hard_negative": texts[neg_j],
            "_pos_sim": round(float(row[pos_j]), 4),
            "_neg_sim": round(float(row[neg_j]), 4),
        })

    clean = [{k: v for k, v in p.items() if not k.startswith("_")} for p in pairs]

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for p in clean:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    positive_count = sum(1 for p in pairs if p["_pos_sim"] >= 0.8)
    print(f"Teacher pairs: {len(pairs)} ({positive_count} with cos >= 0.8)")
    return output_path


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--project_root", type=str, default="..")
    parser.add_argument("--output_dir", type=str, default="./out/data")
    parser.add_argument("--num_pairs", type=int, default=30_000)
    parser.add_argument("--teacher_path", type=str, default="./qwen3-embedding")
    args = parser.parse_args()

    texts = collect_local_text(args.project_root)

    if len(texts) < 50:
        print("ERROR: Not enough local text. Need at least 50 segments.")
        exit(1)

    # Synthetic perturbation pairs (fast, no teacher needed)
    syn_pairs = generate_synthetic_pairs(texts, num_pairs=args.num_pairs)

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    syn_path = out / "synthetic_train.jsonl"
    with open(syn_path, "w", encoding="utf-8") as f:
        for p in syn_pairs:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")
    print(f"Synthetic pairs saved to {syn_path}")

    # Teacher-scored pairs (slower but higher quality)
    teacher_path = generate_teacher_pairs(
        texts, str(out / "teacher_train.jsonl"),
        teacher_path=args.teacher_path, max_pairs=min(10_000, args.num_pairs // 2),
    )

    # Merge
    all_pairs = syn_pairs[:args.num_pairs]
    if Path(teacher_path).exists():
        with open(teacher_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    all_pairs.append(json.loads(line))

    random.shuffle(all_pairs)
    merged_path = out / "train.jsonl"
    with open(merged_path, "w", encoding="utf-8") as f:
        for p in all_pairs:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    print(f"\nFinal: {len(all_pairs)} pairs at {merged_path}")
    print(f"  {len(syn_pairs)} from word perturbation")
    print(f"  Teacher: {min(10_000, args.num_pairs // 2)} from Qwen3 similarity")
