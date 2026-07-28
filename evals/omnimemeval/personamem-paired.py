# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "scipy",
# ]
# ///
"""Paired comparison for official PersonaMem response artifacts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from scipy.stats import binomtest

ROW_ID = re.compile(r"^pm_exper_user_(\d+)_")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--left", type=Path, required=True)
    parser.add_argument("--right", type=Path, required=True)
    parser.add_argument("--left-label", default="left")
    parser.add_argument("--right-label", default="right")
    return parser.parse_args()


def load(path: Path) -> dict[int, tuple[bool, str]]:
    artifact = json.loads(path.read_text(encoding="utf-8"))
    rows: dict[int, tuple[bool, str]] = {}
    for key, response in artifact.items():
        match = ROW_ID.match(key)
        if not match:
            raise ValueError(f"unrecognised PersonaMem key: {key}")
        results = response.get("results", [])
        if len(results) != 1:
            raise ValueError(f"{key} must contain exactly one answer run")
        rows[int(match.group(1))] = (
            bool(results[0]["is_correct"]),
            str(response["category"]),
        )
    return rows


def main() -> None:
    args = parse_args()
    left = load(args.left)
    right = load(args.right)
    if left.keys() != right.keys():
        raise ValueError("paired artifacts contain different question IDs")

    categories = ["all", *sorted({category for _, category in left.values()})]
    print(f"{args.left_label} vs {args.right_label}")
    for category in categories:
        ids = [
            row_id
            for row_id, (_, row_category) in left.items()
            if category == "all" or row_category == category
        ]
        wins = sum(left[row_id][0] and not right[row_id][0] for row_id in ids)
        losses = sum(not left[row_id][0] and right[row_id][0] for row_id in ids)
        ties = len(ids) - wins - losses
        left_accuracy = sum(left[row_id][0] for row_id in ids) / len(ids)
        right_accuracy = sum(right[row_id][0] for row_id in ids) / len(ids)
        p_value = binomtest(wins, wins + losses).pvalue if wins + losses else 1.0
        print(
            f"{category:32} "
            f"{left_accuracy:.4f} vs {right_accuracy:.4f} "
            f"W/L/T={wins}/{losses}/{ties} p={p_value:.6g}"
        )


if __name__ == "__main__":
    main()
