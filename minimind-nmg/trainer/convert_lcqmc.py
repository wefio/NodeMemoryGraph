"""Convert LCQMC (Large-scale Chinese Question Matching Corpus) to training triples.

LCQMC format (tab-separated):
  sentence1\tsentence2\tlabel

Labels: 0=dissimilar, 1=similar
Sizes: train 238,766 pairs, test 8,802 pairs

We convert:
  - label=1 pairs → query/positive
  - For hard negatives: randomly sample from label=0 pairs of same anchor,
    or use in-batch negatives during training (hard_negative field optional)
"""

import json
import random
import argparse
from pathlib import Path
from collections import defaultdict
from tqdm import tqdm


def convert_lcqmc(input_path: str, output_path: str, max_pairs: int = 0,
                   min_chars: int = 4, dedup_threshold: float = 0.95):
    """Convert LCQMC TSV to JSONL training format."""
    
    positives = []  # [(sent1, sent2), ...]
    negatives_map = defaultdict(list)  # sent1 → [sent2_dissimilar, ...]

    with open(input_path, "r", encoding="utf-8") as f:
        for line in tqdm(f, desc="  reading", unit=" lines"):
            parts = line.strip().split("\t")
            if len(parts) != 3:
                continue
            sent1, sent2, label = parts
            if len(sent1) < min_chars or len(sent2) < min_chars:
                continue
            if label == "1":
                positives.append((sent1, sent2))
            elif label == "0":
                negatives_map[sent1].append(sent2)

    random.seed(42)
    random.shuffle(positives)

    samples = []
    skipped_no_neg = 0

    for sent1, sent2 in tqdm(positives, desc="  pairing"):
        # Find a hard negative for this anchor
        hard_negs = negatives_map.get(sent1, [])
        if hard_negs:
            hard_neg = random.choice(hard_negs)
        else:
            # Use a random dissimilar sentence from any anchor
            all_negs = [n for negs in negatives_map.values() for n in negs]
            if all_negs:
                hard_neg = random.choice(all_negs)
            else:
                skipped_no_neg += 1
                continue

        samples.append({
            "query": sent1,
            "positive": sent2,
            "hard_negative": hard_neg,
        })

        if max_pairs > 0 and len(samples) >= max_pairs:
            break

    # Deduplicate (same query+positive+negative)
    seen = set()
    unique = []
    for s in samples:
        key = (s["query"], s["positive"], s["hard_negative"])
        if key not in seen:
            seen.add(key)
            unique.append(s)

    # Write
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for s in unique:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    # Stats
    lengths = [len(s["query"]) + len(s["positive"]) + len(s["hard_negative"]) for s in unique]
    print(f"\nSaved {len(unique)} triples to {output_path}")
    print(f"  positive pairs: {len(positives)}, anchors w/ negatives: {len(negatives_map)}")
    print(f"  skipped (no negative): {skipped_no_neg}")
    print(f"  lengths: p50={sorted(lengths)[len(lengths)//2]}, "
          f"p90={sorted(lengths)[int(len(lengths)*0.9)]}, max={max(lengths)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="./out/data/LCQMC_train.txt")
    parser.add_argument("--output", default="./out/data/lcqmc_train.jsonl")
    parser.add_argument("--max_pairs", type=int, default=250_000)
    args = parser.parse_args()
    convert_lcqmc(args.input, args.output, args.max_pairs)
