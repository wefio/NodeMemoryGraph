"""Contradiction-pair check: same predicate_key, opposite polarity.

Turns contradiction detection into a deterministic SQL self-join over the
extracted metadata. Prints candidate contradictions for manual inspection.

Usage:
  .benchmarks/omni-venv/Scripts/python.exe evals/omnimemeval/polarity-pairs.py \
      --db .benchmarks/polarity-experiment.sqlite
"""

import argparse
import sqlite3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    args = ap.parse_args()

    db = sqlite3.connect(args.db)
    pairs = db.execute(
        """
        SELECT a.predicate_key,
               a.statement, a.polarity, a.confidence, a.created_at,
               b.statement, b.polarity, b.confidence, b.created_at
        FROM memory_records a
        JOIN memory_records b
          ON a.predicate_key = b.predicate_key
         AND a.polarity = 'affirmative' AND b.polarity = 'negative'
         AND a.id < b.id
        ORDER BY a.predicate_key
        """
    ).fetchall()

    print(f"{len(pairs)} contradiction candidate pairs\n")
    for key, sa, pa, ca, ta, sb, pb, cb, tb in pairs:
        print(f"== {key}")
        print(f"  [+{ca:.2f} {ta[:10]}] {sa[:120]}")
        print(f"  [-{cb:.2f} {tb[:10]}] {sb[:120]}\n")

    dup = db.execute(
        """
        SELECT predicate_key, COUNT(*) n, COUNT(DISTINCT polarity) np
        FROM memory_records WHERE predicate_key IS NOT NULL
        GROUP BY predicate_key HAVING n > 1 ORDER BY n DESC LIMIT 15
        """
    ).fetchall()
    print("top shared predicate_keys (key, rows, distinct polarities):")
    for key, n, np_ in dup:
        print(f"  {n}x pol={np_}  {key}")
    db.close()


if __name__ == "__main__":
    main()
