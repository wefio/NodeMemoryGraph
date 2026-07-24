"""Convert Chinese NLI datasets to training triples.

Supported formats:
  1. shibing624/nli-zh-all (JSONL): {"sentence1": "...", "sentence2": "...", "label": "entailment"|"neutral"|"contradiction"}
  2. daryaded/zh-nli (same format as AllNLI)
  3. CNSD (Chinese SNLI) in JSONL format

Conversion: entailment→positive, contradiction→hard_negative
"""

import json
import random
import argparse
from pathlib import Path
from collections import defaultdict
from tqdm import tqdm


def convert_zh_nli(input_path: str, output_path: str, max_pairs: int = 0,
                    min_chars: int = 4, max_chars: int = 2000):
    """Convert Chinese NLI JSONL/TSV to training triples."""

    data = defaultdict(lambda: {"entailments": [], "contradictions": []})
    total = 0
    format_type = None  # auto-detect

    with open(input_path, "r", encoding="utf-8") as f:
        for line in tqdm(f, desc="  reading", unit=" lines"):
            if not line.strip():
                continue
            total += 1

            # Try JSON
            try:
                obj = json.loads(line)
                sent1 = obj.get("sentence1") or obj.get("sent1")
                sent2 = obj.get("sentence2") or obj.get("sent2")
                label = obj.get("label") or obj.get("gold_label")
                format_type = "jsonl"
            except json.JSONDecodeError:
                # Try TSV (like AllNLI: split, dataset, filename, sent1, sent2, label)
                parts = line.strip().split("\t")
                if len(parts) == 6:
                    sent1, sent2, label = parts[3], parts[4], parts[5]
                    format_type = "tsv_6col"
                elif len(parts) == 3:
                    sent1, sent2, label = parts[0], parts[1], parts[2]
                    format_type = "tsv_3col"
                else:
                    continue

            if not sent1 or not sent2:
                continue
            if len(sent1) < min_chars or len(sent2) < min_chars:
                continue
            if len(sent1) > max_chars or len(sent2) > max_chars:
                continue

            # Normalize label
            label = str(label).lower().strip()
            if label in ("entailment", "entail", "1", "similar"):
                data[sent1]["entailments"].append(sent2)
            elif label in ("contradiction", "contradict", "0", "dissimilar"):
                data[sent1]["contradictions"].append(sent2)

    print(f"  format: {format_type}, total lines: {total}")
    print(f"  unique anchors: {len(data)}, "
          f"anchors w/ entailment: {sum(1 for v in data.values() if v['entailments'])}, "
          f"anchors w/ contradiction: {sum(1 for v in data.values() if v['contradictions'])}")

    # Pair
    samples = []
    for sent1, group in tqdm(data.items(), desc="  pairing"):
        if not group["entailments"] or not group["contradictions"]:
            continue
        for pos in group["entailments"]:
            neg = random.choice(group["contradictions"])
            samples.append({
                "query": sent1,
                "positive": pos,
                "hard_negative": neg,
            })

    # Deduplicate
    seen = set()
    unique = []
    for s in samples:
        key = (s["query"], s["positive"], s["hard_negative"])
        if key not in seen:
            seen.add(key)
            unique.append(s)

    if max_pairs > 0 and len(unique) > max_pairs:
        random.seed(42)
        unique = random.sample(unique, max_pairs)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for s in unique:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    lengths = [len(s["query"]) + len(s["positive"]) + len(s["hard_negative"]) for s in unique]
    print(f"\nSaved {len(unique)} triples to {output_path}")
    print(f"  lengths: p50={sorted(lengths)[len(lengths)//2]}, "
          f"p90={sorted(lengths)[int(len(lengths)*0.9)]}, max={max(lengths)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="./out/data/zh_nli_train.jsonl")
    parser.add_argument("--output", default="./out/data/zh_nli_train.jsonl")
    parser.add_argument("--max_pairs", type=int, default=150_000)
    parser.add_argument("--min_chars", type=int, default=4)
    parser.add_argument("--max_chars", type=int, default=2000)
    args = parser.parse_args()
    convert_zh_nli(args.input, args.output, args.max_pairs, args.min_chars, args.max_chars)
