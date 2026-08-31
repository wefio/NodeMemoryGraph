"""Audit whether retrieval-only signals predict single/multi evidence and completeness.

The probe uses LoCoMo evidence IDs only as held-out labels. Retrieval and features
never see those labels. Conversations are kept intact across five validation folds.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer


def normalize(matrix: np.ndarray) -> np.ndarray:
    return matrix / np.maximum(
        np.linalg.norm(matrix, axis=1, keepdims=True), np.finfo(matrix.dtype).eps
    )


def top(scores: np.ndarray, count: int) -> list[int]:
    return np.argsort(-scores, kind="stable")[:count].tolist()


def qpp2_order(query: np.ndarray, docs: np.ndarray, pool: list[int]) -> list[int]:
    if len(pool) < 2:
        return pool.copy()
    local = docs[pool]
    neighbours = local @ local.T
    np.fill_diagonal(neighbours, -1.0)
    nearest = np.sort(neighbours, axis=1)[:, -min(3, len(pool) - 1) :].mean(axis=1)
    score = 0.7 * (local @ query) + 0.3 * nearest
    return [pool[index] for index in np.argsort(-score, kind="stable")]


def rrf(routes: list[tuple[list[int], float]], constant: int = 60) -> tuple[list[int], dict[int, float]]:
    scores: dict[int, float] = {}
    best: dict[int, int] = {}
    for route, weight in routes:
        for rank, value in enumerate(dict.fromkeys(route), start=1):
            scores[value] = scores.get(value, 0.0) + weight / (constant + rank)
            best[value] = min(best.get(value, rank), rank)
    order = sorted(scores, key=lambda value: (-scores[value], best[value], value))
    return order, scores


def evidence_ids(values: list[object]) -> set[str]:
    result: set[str] = set()
    for value in values:
        for item in str(value).replace(";", ",").split(","):
            if item.strip():
                result.add(item.strip())
    return result


def softmax(values: np.ndarray, temperature: float = 0.08) -> np.ndarray:
    shifted = (values - np.max(values)) / temperature
    weights = np.exp(np.clip(shifted, -50, 50))
    return weights / max(float(weights.sum()), np.finfo(values.dtype).eps)


def features(query: np.ndarray, docs: np.ndarray, limit: int) -> tuple[np.ndarray, list[int]]:
    direct_scores = docs @ query
    direct = top(direct_scores, min(50, len(docs)))
    seed = direct[: min(20, len(direct))]
    reverse_top1 = top(docs @ docs[direct[0]], min(50, len(docs)))
    local_rank = qpp2_order(query, docs, seed)
    anchors = local_rank[: min(3, len(local_rank))]
    weights = np.maximum(0.0, docs[anchors] @ query) + 1e-6
    probe = np.average(docs[anchors], axis=0, weights=weights)
    probe /= max(float(np.linalg.norm(probe)), np.finfo(probe.dtype).eps)
    reverse_qpp2 = top(docs @ probe, min(50, len(docs)))
    fused, fused_scores = rrf([(direct, 1.5), (reverse_top1, 1.0), (reverse_qpp2, 1.0)])
    selected = fused[:limit]

    selected_direct = direct_scores[selected]
    probability = softmax(selected_direct)
    top1 = float(selected_direct[0])
    gap = top1 - float(selected_direct[1]) if len(selected_direct) > 1 else top1
    route_support = sum(selected[0] in route[:limit] for route in (direct, reverse_top1, reverse_qpp2)) / 3
    fused_values = np.array([fused_scores[value] for value in selected], dtype=np.float32)
    fused_concentration = float(fused_values[0] / max(float(fused_values.sum()), 1e-9))
    qpp_mass_top1 = float(probability[0])
    effective_count = float(math.exp(-float(np.sum(probability * np.log(probability + 1e-12)))))
    local = docs[selected[: min(8, len(selected))]]
    diversity = 0.0
    if len(local) > 1:
        similarity = local @ local.T
        diversity = float(1 - similarity[np.triu_indices(len(local), 1)].mean())
    return np.array(
        [top1, gap, route_support, fused_concentration, qpp_mass_top1, effective_count, diversity],
        dtype=np.float64,
    ), selected


def fit_logistic(x: np.ndarray, y: np.ndarray, steps: int = 800) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = x.mean(axis=0)
    scale = np.maximum(x.std(axis=0), 1e-6)
    z = np.column_stack([np.ones(len(x)), (x - mean) / scale])
    weights = np.zeros(z.shape[1])
    positive = max(float(y.mean()), 1e-3)
    sample_weight = np.where(y == 1, 0.5 / positive, 0.5 / max(1 - positive, 1e-3))
    for step in range(steps):
        prediction = 1 / (1 + np.exp(-np.clip(z @ weights, -30, 30)))
        gradient = z.T @ ((prediction - y) * sample_weight) / len(y)
        weights -= 0.15 / math.sqrt(1 + step / 100) * gradient
    return weights, mean, scale


def predict(x: np.ndarray, model: tuple[np.ndarray, np.ndarray, np.ndarray]) -> np.ndarray:
    weights, mean, scale = model
    z = np.column_stack([np.ones(len(x)), (x - mean) / scale])
    return 1 / (1 + np.exp(-np.clip(z @ weights, -30, 30)))


def auc(y: np.ndarray, score: np.ndarray) -> float:
    positive = score[y == 1]
    negative = score[y == 0]
    if len(positive) == 0 or len(negative) == 0:
        return float("nan")
    return float(sum((p > negative).sum() + 0.5 * (p == negative).sum() for p in positive) / (len(positive) * len(negative)))


def metrics(y: np.ndarray, score: np.ndarray) -> dict[str, float]:
    predicted = score >= 0.5
    positive_recall = float(predicted[y == 1].mean()) if np.any(y == 1) else 0.0
    negative_recall = float((~predicted[y == 0]).mean()) if np.any(y == 0) else 0.0
    return {
        "auc": auc(y, score),
        "balanced_accuracy": (positive_recall + negative_recall) / 2,
        "positive_recall": positive_recall,
        "negative_recall": negative_recall,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    rows = json.loads(args.data.read_text(encoding="utf-8"))
    encoder = SentenceTransformer(args.model, local_files_only=True)
    all_features: list[np.ndarray] = []
    multi_labels: list[int] = []
    complete_labels: list[int] = []
    groups: list[int] = []

    for conversation_index, row in enumerate(rows):
        conversation = row["conversation"]
        turns = [
            turn
            for key, session in conversation.items()
            if key.startswith("session_") and key[len("session_") :].isdigit()
            for turn in session
        ]
        turn_ids = [str(turn["dia_id"]) for turn in turns]
        turn_texts = [str(turn["text"]) for turn in turns]
        questions = list(row["qa"])
        vectors = normalize(
            encoder.encode(
                turn_texts + [str(qa["question"]) for qa in questions],
                batch_size=128,
                show_progress_bar=False,
            ).astype(np.float32)
        )
        docs = vectors[: len(turns)]
        id_to_index = {value: index for index, value in enumerate(turn_ids)}
        for question, query in zip(questions, vectors[len(turns) :], strict=True):
            labelled = evidence_ids(question.get("evidence", []))
            relevant = {id_to_index[value] for value in labelled if value in id_to_index}
            if not relevant:
                continue
            signal, selected = features(query, docs, args.limit)
            all_features.append(signal)
            multi_labels.append(int(len(relevant) > 1))
            complete_labels.append(int(relevant.issubset(selected)))
            groups.append(conversation_index)

    x = np.vstack(all_features)
    multi = np.asarray(multi_labels)
    complete = np.asarray(complete_labels)
    group = np.asarray(groups)
    multi_predictions = np.zeros(len(x))
    complete_predictions = np.zeros(len(x))
    for fold in range(5):
        validation = group % 5 == fold
        training = ~validation
        multi_predictions[validation] = predict(x[validation], fit_logistic(x[training], multi[training]))
        complete_predictions[validation] = predict(x[validation], fit_logistic(x[training], complete[training]))

    names = ["top1", "gap", "route_support", "rrf_concentration", "qpp2_top1_mass", "effective_count", "diversity"]
    report = {
        "protocol": {
            "dataset": str(args.data.resolve()),
            "questions": len(x),
            "folding": "five folds grouped by LoCoMo conversation",
            "retrieval": "record-level BGE; original + Top1 reverse + QPP2 reverse; weighted RRF@20",
            "labels_used_for_retrieval_or_features": False,
            "model": args.model,
            "limit": args.limit,
        },
        "prevalence": {
            "multi_evidence": float(multi.mean()),
            "complete_at_limit": float(complete.mean()),
        },
        "multi_evidence": metrics(multi, multi_predictions),
        "complete_at_limit": metrics(complete, complete_predictions),
        "single_feature_auc": {
            name: {
                "multi_evidence": auc(multi, x[:, index]),
                "complete_at_limit": auc(complete, x[:, index]),
            }
            for index, name in enumerate(names)
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
