"""Audit exact BEAM source-message retrieval without an answer model.

This is an auxiliary retrieval diagnostic, not BEAM's official Nugget Score.
It uses the benchmark's ``source_chat_ids`` labels and reports exact normalized
source-message coverage, split by capability and source actor.
"""

from __future__ import annotations

import ast
import json
import math
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(
            "usage: audit-beam-retrieval.py <beam.jsonl> <search-results.json> [...]"
        )
    dataset = [
        json.loads(line)
        for line in Path(sys.argv[1]).resolve().read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    for result_path in sys.argv[2:]:
        results = json.loads(Path(result_path).resolve().read_text(encoding="utf-8"))
        print(json.dumps(audit(dataset, results, result_path), indent=2))


def audit(
    dataset: list[dict[str, Any]],
    results: dict[str, list[dict[str, Any]]],
    source: str,
) -> dict[str, Any]:
    by_conversation: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    for entries in results.values():
        for entry in entries:
            by_conversation[str(entry["conv_id"])][int(entry["question_idx"])] = entry

    question_total = question_any = question_all = 0
    evidence_total = evidence_hits = 0
    missing_labels = 0
    context_characters: list[int] = []
    latencies: list[float] = []
    first_query_latencies: list[float] = []
    steady_query_latencies: list[float] = []
    actors: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    capabilities: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])

    for conversation in dataset:
        conversation_id = str(conversation["conversation_id"])
        messages = {
            int(message["id"]): message
            for session in conversation["chat"]
            for message in session
        }
        questions = ast.literal_eval(conversation["probing_questions"])
        question_index = 0
        for capability, entries in questions.items():
            for question in entries:
                result = by_conversation.get(conversation_id, {}).get(question_index)
                if result is None:
                    raise RuntimeError(
                        f"missing result for conversation={conversation_id} "
                        f"question={question_index}"
                    )
                context = normalize(str(result.get("search_context", "")))
                source_ids = unique_ints(question.get("source_chat_ids"))
                hits: list[bool] = []
                for source_id in source_ids:
                    message = messages.get(source_id)
                    if message is None:
                        missing_labels += 1
                        continue
                    actor = str(message.get("role", "unknown"))
                    hit = normalize(str(message.get("content", ""))) in context
                    hits.append(hit)
                    actors[actor][0] += int(hit)
                    actors[actor][1] += 1

                if hits:
                    question_total += 1
                    question_any += int(any(hits))
                    question_all += int(all(hits))
                    evidence_hits += sum(hits)
                    evidence_total += len(hits)
                    capability_stats = capabilities[str(capability)]
                    capability_stats[0] += int(any(hits))
                    capability_stats[1] += int(all(hits))
                    capability_stats[2] += sum(hits)
                    capability_stats[3] += len(hits)
                    capability_stats[4] += 1

                raw_context = str(result.get("search_context", ""))
                context_characters.append(len(raw_context))
                duration = result.get("search_duration_ms")
                if isinstance(duration, (int, float)) and math.isfinite(duration):
                    value = float(duration)
                    latencies.append(value)
                    if question_index == 0:
                        first_query_latencies.append(value)
                    else:
                        steady_query_latencies.append(value)
                question_index += 1

    return {
        "source": str(Path(source).resolve()),
        "questionsWithEvidence": question_total,
        "missingLabels": missing_labels,
        "evidenceHits": evidence_hits,
        "evidenceTotal": evidence_total,
        "anyEvidenceRate": ratio(question_any, question_total),
        "allEvidenceRate": ratio(question_all, question_total),
        "evidenceRecall": ratio(evidence_hits, evidence_total),
        "meanContextCharacters": mean(context_characters),
        "latencyMs": summary(latencies),
        "firstQueryLatencyMs": summary(first_query_latencies),
        "steadyQueryLatencyMs": summary(steady_query_latencies),
        "actorEvidenceRecall": {
            actor: {
                "hits": values[0],
                "total": values[1],
                "recall": ratio(values[0], values[1]),
            }
            for actor, values in sorted(actors.items())
        },
        "capabilityEvidenceRecall": {
            capability: {
                "any": ratio(values[0], values[4]),
                "all": ratio(values[1], values[4]),
                "evidence": ratio(values[2], values[3]),
            }
            for capability, values in sorted(capabilities.items())
        },
    }


def unique_ints(value: Any) -> list[int]:
    values: list[int] = []

    def visit(current: Any) -> None:
        if isinstance(current, bool):
            return
        if isinstance(current, int):
            values.append(current)
        elif isinstance(current, list):
            for item in current:
                visit(item)
        elif isinstance(current, dict):
            for item in current.values():
                visit(item)

    visit(value)
    return list(dict.fromkeys(values))


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
