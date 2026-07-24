"""Convert AllNLI TSV to NMG training format: query / positive / hard_negative triples."""

import json
import gzip
import argparse
from pathlib import Path
from collections import defaultdict, Counter
from tqdm import tqdm


def convert_all_nli(tsv_path: str, output_path: str, max_pairs: int = 0,
                     min_chars: int = 10, max_chars: int = 2000):
    """
    Convert AllNLI TSV.gz to JSONL training format.

    AllNLI format (tab-separated):
      split, dataset, filename, sentence1, sentence2, label

    We create triples:
      - sentence1 as anchor/query
      - entailment sentences as positive
      - contradiction sentences as hard_negative

    Strategy: for each unique sentence1, pair each entailment with one contradiction.
    """
    data = defaultdict(lambda: {"entailments": [], "contradictions": []})

    with gzip.open(tsv_path, "rt", encoding="utf-8") as f:
        header = f.readline()  # skip header
        for line in tqdm(f, desc="  reading", unit=" lines"):
            parts = line.strip().split("\t")
            if len(parts) != 6:
                continue
            split, dataset, filename, sent1, sent2, label = parts
            if len(sent1) < min_chars or len(sent2) < min_chars:
                continue
            if len(sent1) > max_chars or len(sent2) > max_chars:
                continue
            if label == "entailment":
                data[sent1]["entailments"].append(sent2)
            elif label == "contradiction":
                data[sent1]["contradictions"].append(sent2)

    samples = []
    for sent1, group in tqdm(data.items(), desc="  pairing"):
        if not group["entailments"] or not group["contradictions"]:
            continue
        # All combinations of (entailment, contradiction) for this anchor
        for pos in group["entailments"]:
            for neg in group["contradictions"]:
                samples.append({
                    "query": sent1,
                    "positive": pos,
                    "hard_negative": neg,
                })

    # Deduplicate (same query+positive+negative)
    seen = set()
    unique = []
    for s in samples:
        key = (s["query"], s["positive"], s["hard_negative"])
        if key not in seen:
            seen.add(key)
            unique.append(s)

    # Limit
    if max_pairs > 0 and len(unique) > max_pairs:
        import random
        random.seed(42)
        unique = random.sample(unique, max_pairs)

    # Write
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for s in unique:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    # Stats
    lengths = [len(s["query"]) + len(s["positive"]) + len(s["hard_negative"]) for s in unique]
    print(f"\nSaved {len(unique)} triples to {output_path}")
    print(f"  lengths: p50={sorted(lengths)[len(lengths)//2]}, "
          f"p90={sorted(lengths)[int(len(lengths)*0.9)]}, "
          f"max={max(lengths)}")
    print(f"  unique anchors: {len(data)}, triples/anchor: {len(unique)/len(data):.1f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="./out/data/AllNLI.tsv.gz")
    parser.add_argument("--output", default="./out/data/all_nli_train.jsonl")
    parser.add_argument("--max_pairs", type=int, default=500_000, help="Cap total pairs")
    args = parser.parse_args()
    convert_all_nli(args.input, args.output, args.max_pairs)
