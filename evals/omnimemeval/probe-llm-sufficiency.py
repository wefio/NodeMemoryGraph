"""Probe: can an LLM judge whether the retrieved top-k records are sufficient to
answer a LoCoMo question — and does that judgment predict (a) multi-evidence
questions, (b) evidence completeness (labels used only for evaluation)?

Protocol follows locomo-evidence-mode-signal-2026-08-02.md: record-level BGE
retrieval, weighted RRF top-12, no label inside retrieval or the prompt. The
sufficiency judgment is the LLM's own; we then compare it against held-out
evidence labels. Cost is bounded by a balanced sample (default 150 questions).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import requests
from sentence_transformers import SentenceTransformer

TURN_CAP = 400  # characters per retrieved record in the prompt


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


def rrf(routes: list[tuple[list[int], float]], constant: int = 60) -> list[int]:
    scores: dict[int, float] = {}
    best: dict[int, int] = {}
    for route, weight in routes:
        for rank, value in enumerate(dict.fromkeys(route), start=1):
            scores[value] = scores.get(value, 0.0) + weight / (constant + rank)
            best[value] = min(best.get(value, rank), rank)
    return sorted(scores, key=lambda value: (-scores[value], best[value], value))


def retrieve(query: np.ndarray, docs: np.ndarray, limit: int = 12) -> list[int]:
    direct = top(docs @ query, min(50, len(docs)))
    seed = direct[: min(20, len(direct))]
    reverse_top1 = top(docs @ docs[direct[0]], min(50, len(docs)))
    local_rank = qpp2_order(query, docs, seed)
    anchors = local_rank[: min(3, len(local_rank))]
    weights = np.maximum(0.0, docs[anchors] @ query) + 1e-6
    probe = np.average(docs[anchors], axis=0, weights=weights)
    probe /= max(float(np.linalg.norm(probe)), np.finfo(probe.dtype).eps)
    reverse_qpp2 = top(docs @ probe, min(50, len(docs)))
    return rrf([(direct, 1.5), (reverse_top1, 1.0), (reverse_qpp2, 1.0)])[:limit]


def evidence_ids(values: list[object]) -> set[str]:
    result: set[str] = set()
    for value in values:
        for item in str(value).replace(";", ",").split(","):
            if item.strip():
                result.add(item.strip())
    return result


def ask(api_key: str, prompt: str, model: str) -> tuple[str, dict]:
    start = time.monotonic()
    r = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": model, "temperature": 0, "messages": [{"role": "user", "content": prompt}]},
        timeout=180,
    )
    r.raise_for_status()
    data = r.json()
    text = data["choices"][0]["message"]["content"].strip()
    usage = data.get("usage", {})
    return text, {"latency_s": time.monotonic() - start, "usage": usage}


def parse_verdict(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return {"sufficient": None, "confidence": None, "missing": None, "raw": text[:200]}
    try:
        parsed = json.loads(match.group(0))
        return {
            "sufficient": bool(parsed.get("sufficient")),
            "confidence": parsed.get("confidence"),
            "missing": parsed.get("missing"),
        }
    except json.JSONDecodeError:
        return {"sufficient": None, "confidence": None, "missing": None, "raw": text[:200]}


def build_prompt(question: str, records: list[str]) -> str:
    numbered = "\n".join(f"{i}. {r}" for i, r in enumerate(records, start=1))
    return (
        "You are an assistant deciding whether retrieved memory records are enough to answer a "
        "question from a prior long-term-memory store.\n\n"
        f"Question: {question}\n\n"
        f"Retrieved memory records:\n{numbered}\n\n"
        'Are these records sufficient to answer the question accurately? Reply with ONLY a JSON '
        'object: {"sufficient": true or false, "confidence": a number 0.0 to 1.0, '
        '"missing": "what is missing, or null if sufficient"}.'
    )


def auc(y: np.ndarray, score: np.ndarray) -> float:
    positive = score[y == 1]
    negative = score[y == 0]
    if len(positive) == 0 or len(negative) == 0:
        return float("nan")
    return float(sum((p > negative).sum() + 0.5 * (p == negative).sum() for p in positive) / (len(positive) * len(negative)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--max-questions", type=int, default=150)
    parser.add_argument("--per-conversation", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--llm", default="deepseek-chat")
    args = parser.parse_args()

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        sys.exit("DEEPSEEK_API_KEY not set")

    rows = json.loads(args.data.read_text(encoding="utf-8"))
    encoder = SentenceTransformer(args.model, local_files_only=True)
    rng = random.Random(args.seed)

    # Balanced sample: equal single- and multi-evidence questions, capped per conversation.
    buckets: dict[int, list[tuple[int, int, dict]]] = {0: [], 1: []}
    for ci, row in enumerate(rows):
        for qi, qa in enumerate(row.get("qa", [])):
            if qa.get("evidence"):
                ev = evidence_ids(qa.get("evidence", []))
                buckets[int(len(ev) > 1)].append((ci, qi, qa))
    sample: list[tuple[int, int, dict]] = []
    per_bucket = args.max_questions // 2
    for bucket in (0, 1):
        pool = buckets[bucket]
        rng.shuffle(pool)
        used: dict[int, int] = {}  # per-bucket cap: each conversation appears in both buckets
        for ci, qi, qa in pool:
            if used.get(ci, 0) >= args.per_conversation:
                continue
            sample.append((ci, qi, qa))
            used[ci] = used.get(ci, 0) + 1
            if len(sample) >= args.max_questions:
                break

    # Encode each sampled conversation's turns once.
    encoded: dict[int, tuple[np.ndarray, list[str], dict[str, int]]] = {}
    for ci, _, _ in sample:
        if ci in encoded:
            continue
        conversation = rows[ci]["conversation"]
        turns = [
            turn
            for key, session in conversation.items()
            if key.startswith("session_") and key[len("session_") :].isdigit()
            for turn in session
        ]
        turn_ids = [str(turn["dia_id"]) for turn in turns]
        turn_texts = [str(turn["text"]) for turn in turns]
        vectors = normalize(
            encoder.encode(turn_texts, batch_size=128, show_progress_bar=False).astype(np.float32)
        )
        encoded[ci] = (vectors, turn_texts, dict(zip(turn_ids, range(len(turn_ids)))))

    judgments: list[dict] = []
    total_prompt_tokens = 0
    total_completion_tokens = 0
    for ci, qi, qa in sample:
        docs, turn_texts, id_to_index = encoded[ci]
        qtext = str(qa["question"])
        qvec = normalize(encoder.encode([qtext], show_progress_bar=False).astype(np.float32))[0]
        selected = retrieve(qvec, docs, args.limit)
        records = [turn_texts[i][:TURN_CAP] for i in selected]
        labelled_ev = evidence_ids(qa.get("evidence", []))
        relevant = {id_to_index[v] for v in labelled_ev if v in id_to_index}
        complete = bool(relevant.issubset(set(selected)))
        multi = len(relevant) > 1

        prompt = build_prompt(qtext, records)
        verdict, meta = ask(api_key, prompt, args.llm)
        parsed = parse_verdict(verdict)
        usage = meta.get("usage", {})
        total_prompt_tokens += int(usage.get("prompt_tokens", 0))
        total_completion_tokens += int(usage.get("completion_tokens", 0))
        judgments.append(
            {
                "conversation": ci,
                "question": qtext[:120],
                "n_evidence": len(relevant),
                "multi": int(multi),
                "complete": int(complete),
                "sufficient": parsed.get("sufficient"),
                "confidence": parsed.get("confidence"),
                "missing": parsed.get("missing"),
                "latency_s": round(meta.get("latency_s", 0.0), 2),
                "parse_error": "raw" in parsed,
            }
        )
        print(f"[{len(judgments)}/{len(sample)}] multi={int(multi)} complete={int(complete)} "
              f"sufficient={parsed.get('sufficient')} conf={parsed.get('confidence')}", flush=True)

    valid = [j for j in judgments if j["sufficient"] is not None]
    multi = np.asarray([j["multi"] for j in valid])
    complete = np.asarray([j["complete"] for j in valid])
    suff = np.asarray([int(j["sufficient"]) for j in valid])
    conf = np.asarray([float(j["confidence"] or 0) for j in valid])

    def report(name: str, y: np.ndarray) -> dict:
        positive = y == 1
        negative = y == 0
        if positive.sum() == 0 or negative.sum() == 0:
            return {"n": int(len(y)), "prevalence": float(y.mean()), "auc_conf": None, "auc_sufficient": None}
        tp = int(((suff == 1) & positive).sum())
        fp = int(((suff == 1) & negative).sum())
        tn = int(((suff == 0) & negative).sum())
        fn = int(((suff == 0) & positive).sum())
        return {
            "n": int(len(y)),
            "prevalence": float(y.mean()),
            "auc_conf": auc(y, conf),
            "auc_sufficient": auc(y, suff.astype(float)),
            "confusion": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
            "balanced_accuracy": (tp / max(tp + fn, 1) + tn / max(tn + fp, 1)) / 2,
        }

    risky = [j for j in valid if j["sufficient"] and not j["complete"]]

    result = {
        "protocol": {
            "dataset": str(args.data.resolve()),
            "questions_sampled": len(sample),
            "questions_valid": len(valid),
            "sample_balance": "50/50 single vs multi evidence, capped per conversation",
            "retrieval": "record-level BGE; original + Top1 reverse + QPP2 reverse; weighted RRF",
            "labels_used_in_prompt_or_retrieval": False,
            "llm": args.llm,
            "seed": args.seed,
            "limit": args.limit,
        },
        "sufficiency_vs_multi": report("multi", multi),
        "sufficiency_vs_complete": report("complete", complete),
        "risk": {
            "sufficient_but_incomplete": len(risky),
            "share_of_sufficient": len(risky) / max(sum(1 for j in valid if j["sufficient"]), 1),
            "examples": [{"question": j["question"], "missing": j["missing"]} for j in risky[:5]],
        },
        "cost": {
            "prompt_tokens": total_prompt_tokens,
            "completion_tokens": total_completion_tokens,
            "calls": len(judgments),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
