"""Retrieval-only LongMemEval ablation for reverse lookup around QPP2.

This is deliberately an offline probe, not a production retrieval policy.  It
compares equal-size Top-K outputs and never uses answer/evidence labels while
ranking.  Labels are read only after selection to compute session recall.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer


@dataclass
class Metrics:
    questions: int = 0
    evidence: int = 0
    found: int = 0
    any_hits: int = 0
    all_hits: int = 0
    selected: int = 0
    latency_ms: float = 0.0

    def add(self, selected: list[int], evidence: set[int], elapsed_ms: float) -> None:
        found = len(set(selected) & evidence)
        self.questions += 1
        self.evidence += len(evidence)
        self.found += found
        self.any_hits += int(found > 0)
        self.all_hits += int(found == len(evidence))
        self.selected += len(selected)
        self.latency_ms += elapsed_ms

    def summary(self) -> dict[str, float | int]:
        n = max(1, self.questions)
        return {
            **asdict(self),
            "strict_recall": self.found / max(1, self.evidence),
            "any_recall": self.any_hits / n,
            "all_recall": self.all_hits / n,
            "mean_selected": self.selected / n,
            "mean_policy_latency_ms": self.latency_ms / n,
        }


def normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, np.finfo(matrix.dtype).eps)


def top_indices(scores: np.ndarray, limit: int) -> list[int]:
    return np.argsort(-scores, kind="stable")[:limit].tolist()


def qpp2_rank(query: np.ndarray, documents: np.ndarray, pool: list[int]) -> list[int]:
    """Query relevance plus intra-list consistency, without relevance labels."""
    if len(pool) < 2:
        return pool.copy()
    local = documents[pool]
    query_scores = local @ query
    neighbours = local @ local.T
    np.fill_diagonal(neighbours, -1.0)
    nearest = np.sort(neighbours, axis=1)[:, -min(3, len(pool) - 1) :].mean(axis=1)
    scores = 0.7 * query_scores + 0.3 * nearest
    order = np.argsort(-scores, kind="stable")
    return [pool[index] for index in order]


def unique_prefix(groups: list[list[int]], limit: int | None = None) -> list[int]:
    result: list[int] = []
    seen: set[int] = set()
    for group in groups:
        for value in group:
            if value in seen:
                continue
            seen.add(value)
            result.append(value)
            if limit is not None and len(result) >= limit:
                return result
    return result


def reverse_top1(documents: np.ndarray, baseline: list[int], breadth: int) -> list[int]:
    return top_indices(documents @ documents[baseline[0]], breadth)


def reverse_qpp2(
    query: np.ndarray,
    documents: np.ndarray,
    baseline: list[int],
    breadth: int,
) -> list[int]:
    ranked = qpp2_rank(query, documents, baseline)
    anchors = ranked[: min(3, len(ranked))]
    weights = np.maximum(0.0, documents[anchors] @ query) + 1e-6
    probe = np.average(documents[anchors], axis=0, weights=weights)
    probe /= max(float(np.linalg.norm(probe)), np.finfo(probe.dtype).eps)
    return top_indices(documents @ probe, breadth)


def select_variants(
    query: np.ndarray,
    documents: np.ndarray,
    limit: int,
    reverse_breadth: int,
) -> tuple[dict[str, list[int]], dict[str, float]]:
    timings: dict[str, float] = {}
    started = time.perf_counter()
    baseline = top_indices(documents @ query, limit)
    timings["baseline"] = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    top1_reverse = reverse_top1(documents, baseline, reverse_breadth)
    option1_pool = unique_prefix([baseline, top1_reverse])
    option1 = qpp2_rank(query, documents, option1_pool)[:limit]
    timings["top1_reverse_then_qpp2"] = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    qpp_reverse = reverse_qpp2(query, documents, baseline, reverse_breadth)
    option2_pool = unique_prefix([baseline, qpp_reverse])
    option2 = qpp2_rank(query, documents, option2_pool)[:limit]
    timings["qpp2_reverse_then_qpp2"] = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    combined_pool = unique_prefix([
        baseline,
        reverse_top1(documents, baseline, reverse_breadth),
        reverse_qpp2(query, documents, baseline, reverse_breadth),
    ])
    combined = qpp2_rank(query, documents, combined_pool)[:limit]
    timings["combined_then_qpp2"] = (time.perf_counter() - started) * 1000
    return ({
        "baseline": baseline,
        "top1_reverse_then_qpp2": option1,
        "qpp2_reverse_then_qpp2": option2,
        "combined_then_qpp2": combined,
    }, timings)


def session_text(session: list[dict[str, object]], date: str) -> str:
    turns = "\n".join(f"{turn['role']}: {turn['content']}" for turn in session)
    return f"Date: {date}\n{turns}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    parser.add_argument("--category", default="temporal-reasoning")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--reverse-breadth", type=int, default=20)
    parser.add_argument("--max-cases", type=int)
    args = parser.parse_args()

    rows = json.loads(args.data.read_text(encoding="utf-8"))
    rows = [row for row in rows if not args.category or row["question_type"] == args.category]
    if args.max_cases is not None:
        rows = rows[: args.max_cases]
    model = SentenceTransformer(args.model, local_files_only=True)
    totals = {name: Metrics() for name in (
        "baseline", "top1_reverse_then_qpp2", "qpp2_reverse_then_qpp2", "combined_then_qpp2"
    )}
    details: list[dict[str, object]] = []

    for row in rows:
        texts = [
            session_text(session, row["haystack_dates"][index])
            for index, session in enumerate(row["haystack_sessions"])
        ]
        vectors = normalize(model.encode(
            [row["question"], *texts], batch_size=64, show_progress_bar=False
        ).astype(np.float32))
        query, documents = vectors[0], vectors[1:]
        id_to_index = {value: index for index, value in enumerate(row["haystack_session_ids"])}
        evidence = {id_to_index[value] for value in row["answer_session_ids"] if value in id_to_index}
        variants, timings = select_variants(query, documents, args.limit, args.reverse_breadth)
        for name, selected in variants.items():
            totals[name].add(selected, evidence, timings[name])
        details.append({
            "question_id": row["question_id"],
            "question": row["question"],
            "evidence_sessions": [row["haystack_session_ids"][index] for index in sorted(evidence)],
            "selected_sessions": {
                name: [row["haystack_session_ids"][index] for index in selected]
                for name, selected in variants.items()
            },
        })

    report = {
        "method": {
            "unit": "LongMemEval session",
            "labels_used_for_ranking": False,
            "qpp2": "0.7 query cosine + 0.3 mean top-3 intra-list cosine",
            "reverse_anchor_count": 3,
            "limit": args.limit,
            "reverse_breadth": args.reverse_breadth,
            "model": args.model,
            "category": args.category,
        },
        "metrics": {name: value.summary() for name, value in totals.items()},
        "details": details,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["metrics"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
