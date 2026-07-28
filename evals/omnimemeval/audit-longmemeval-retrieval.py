"""Audit exact LongMemEval evidence retrieval without changing official scores.

The official search artifact already contains ``answer_evidences``. This
auxiliary diagnostic checks whether their normalized text appears in the
retrieved context and, when a judged artifact is supplied, correlates evidence
coverage with answer accuracy. It is intentionally stricter than semantic
retrieval and is not an official LongMemEval metric.
"""

from __future__ import annotations

import json
import math
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


ROLE_PREFIX = re.compile(r"^(user|assistant|system|tool)\s*:\s*", re.IGNORECASE)


def main() -> None:
    if len(sys.argv) not in (2, 3):
        raise SystemExit(
            "usage: audit-longmemeval-retrieval.py "
            "<search-results.json> [judged-results.json]"
        )
    search_path = Path(sys.argv[1]).resolve()
    judged_path = Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else None
    search_results = json.loads(search_path.read_text(encoding="utf-8"))
    judged_results = (
        json.loads(judged_path.read_text(encoding="utf-8"))
        if judged_path is not None
        else {}
    )
    print(
        json.dumps(
            audit(search_results, judged_results, search_path, judged_path),
            indent=2,
        )
    )


def audit(
    search_results: dict[str, list[dict[str, Any]]],
    judged_results: dict[str, dict[str, Any]],
    search_path: Path,
    judged_path: Path | None,
) -> dict[str, Any]:
    totals = new_counts()
    categories: dict[str, dict[str, int]] = defaultdict(new_counts)
    actors: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    accuracy: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    latencies: list[float] = []
    context_characters: list[int] = []
    status_counts: dict[str, int] = defaultdict(int)

    for user_id, entries in search_results.items():
        if len(entries) != 1:
            raise RuntimeError(
                f"expected one LongMemEval result for {user_id!r}, got {len(entries)}"
            )
        entry = entries[0]
        status_counts[str(entry.get("status", "missing"))] += 1
        category = str(entry.get("category", "unknown"))
        context = normalize(str(entry.get("search_context", "")))
        evidences = entry.get("answer_evidences") or []
        hits: list[bool] = []
        for evidence in evidences:
            raw = str(evidence)
            match = ROLE_PREFIX.match(raw)
            actor = match.group(1).casefold() if match else "unknown"
            content = raw[match.end() :] if match else raw
            hit = bool(content.strip()) and normalize(content) in context
            hits.append(hit)
            actors[actor][0] += int(hit)
            actors[actor][1] += 1

        if hits:
            add_hits(totals, hits)
            add_hits(categories[category], hits)

        raw_context = str(entry.get("search_context", ""))
        context_characters.append(len(raw_context))
        duration = entry.get("search_duration_ms")
        if isinstance(duration, (int, float)) and math.isfinite(duration):
            latencies.append(float(duration))

        judged = judged_results.get(user_id)
        if judged and judged.get("status") == "success" and judged.get("llm_judgments"):
            correct = int(any(bool(value) for value in judged["llm_judgments"].values()))
            accuracy["judged"][0] += correct
            accuracy["judged"][1] += 1
            if hits:
                bucket = "anyEvidence" if any(hits) else "noEvidence"
                accuracy[bucket][0] += correct
                accuracy[bucket][1] += 1
                bucket = "allEvidence" if all(hits) else "partialEvidence"
                accuracy[bucket][0] += correct
                accuracy[bucket][1] += 1

    return {
        "source": str(search_path),
        "judgedSource": str(judged_path) if judged_path is not None else None,
        "questions": sum(status_counts.values()),
        "statusCounts": dict(sorted(status_counts.items())),
        "questionsWithEvidenceLabels": totals["questions"],
        "evidenceHits": totals["hits"],
        "evidenceTotal": totals["evidence"],
        "anyEvidenceRate": ratio(totals["any"], totals["questions"]),
        "allEvidenceRate": ratio(totals["all"], totals["questions"]),
        "evidenceRecall": ratio(totals["hits"], totals["evidence"]),
        "meanContextCharacters": mean(context_characters),
        "latencyMs": summary(latencies),
        "actorEvidenceRecall": {
            actor: {
                "hits": values[0],
                "total": values[1],
                "recall": ratio(values[0], values[1]),
            }
            for actor, values in sorted(actors.items())
        },
        "categoryEvidenceRecall": {
            category: format_counts(values)
            for category, values in sorted(categories.items())
        },
        "answerAccuracy": {
            bucket: {
                "correct": values[0],
                "total": values[1],
                "accuracy": ratio(values[0], values[1]),
            }
            for bucket, values in sorted(accuracy.items())
        },
    }


def new_counts() -> dict[str, int]:
    return {"questions": 0, "any": 0, "all": 0, "hits": 0, "evidence": 0}


def add_hits(counts: dict[str, int], hits: list[bool]) -> None:
    counts["questions"] += 1
    counts["any"] += int(any(hits))
    counts["all"] += int(all(hits))
    counts["hits"] += sum(hits)
    counts["evidence"] += len(hits)


def format_counts(counts: dict[str, int]) -> dict[str, Any]:
    return {
        "questions": counts["questions"],
        "any": ratio(counts["any"], counts["questions"]),
        "all": ratio(counts["all"], counts["questions"]),
        "evidence": ratio(counts["hits"], counts["evidence"]),
    }


def normalize(value: str) -> str:
    return " ".join(re.findall(r"\w+", value.casefold(), flags=re.UNICODE))


def ratio(numerator: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


def mean(values: list[float] | list[int]) -> float:
    return 0.0 if not values else statistics.fmean(values)


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def summary(values: list[float]) -> dict[str, float]:
    return {
        "mean": mean(values),
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
    }


if __name__ == "__main__":
    main()
