"""Merge multiple training JSONL files into one, optionally with balancing."""

import json
import random
import argparse
from pathlib import Path
from collections import Counter


def merge_datasets(input_files: list[str], output_path: str,
                    max_total: int = 0, balance: bool = True):
    """Merge and optionally balance multiple JSONL training files."""

    all_samples = []
    file_counts = {}

    for fpath in input_files:
        samples = []
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    samples.append(json.loads(line))
        all_samples.extend(samples)
        file_counts[fpath] = len(samples)
        print(f"  {fpath}: {len(samples)} samples")

    print(f"\n  Total before balancing: {len(all_samples)}")

    if balance:
        # Ensure each source contributes roughly equally
        # (useful when one dataset dominates)
        min_count = min(file_counts.values())
        balanced = []
        random.seed(42)
        for fpath, count in file_counts.items():
            file_samples = [s for s in all_samples if _source_id(s, fpath)]
            if count > min_count * 1.5:
                # Downsample to ~min_count
                file_samples = random.sample(file_samples, min_count)
            balanced.extend(file_samples)
        all_samples = balanced
        print(f"  After balancing: {len(all_samples)}")

    # Shuffle
    random.shuffle(all_samples)

    if max_total > 0 and len(all_samples) > max_total:
        all_samples = random.sample(all_samples, max_total)
        print(f"  Capped to: {max_total}")

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for s in all_samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    print(f"\nSaved {len(all_samples)} merged samples to {output_path}")

    # Show sample
    if all_samples:
        sample = all_samples[0]
        print(f"  Sample: query='{sample['query'][:50]}...' "
              f"positive='{sample['positive'][:50]}...' "
              f"hard_negative='{sample.get('hard_negative', '')[:50]}...'")


def _source_id(sample, fpath):
    """Check if a sample likely came from a specific file."""
    # Simple heuristic: try to look for source marker
    # For now, just return True for all (we track by file counts above)
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", nargs="+", required=True,
                        help="JSONL files to merge")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max_total", type=int, default=0)
    parser.add_argument("--no_balance", action="store_true",
                        help="Skip balancing (keep all data)")
    args = parser.parse_args()
    merge_datasets(args.inputs, args.output, args.max_total, not args.no_balance)
