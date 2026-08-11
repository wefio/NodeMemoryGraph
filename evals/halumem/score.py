"""Run HaluMem's official LLM judges on an extraction/update-only artifact.

The upstream aggregate assumes that QA and update records are both non-empty,
which is not true for bounded smoke slices.  This wrapper reuses the official
``process_user`` judgments verbatim and computes only metrics whose denominator
is present, using the same formulas as upstream ``aggregate_eval_results``.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import re
import sys
from pathlib import Path
from typing import Any


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def aggregate(records: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    integrity = records["memory_integrity_records"]
    accuracy = records["memory_accuracy_records"]
    updates = records["memory_update_records"]

    normal = [row for row in integrity if row.get("memory_source") != "interference"]
    interference = [row for row in integrity if row.get("memory_source") == "interference"]
    valid_normal = [row for row in normal if row.get("memory_integrity_score") is not None]
    valid_interference = [
        row for row in interference if row.get("memory_integrity_score") is not None
    ]
    recall = ratio(sum(row["memory_integrity_score"] == 2 for row in normal), len(normal))
    weighted_recall = ratio(
        sum(0.5 * row.get("memory_integrity_score", 0) * row["importance"] for row in normal),
        sum(row["importance"] for row in normal),
    )
    interference_accuracy = ratio(
        sum(row["memory_integrity_score"] == 0 for row in interference), len(interference)
    )

    valid_accuracy = [row for row in accuracy if row.get("memory_accuracy_score") is not None]
    target = [
        row
        for row in accuracy
        if str(row.get("is_included_in_golden_memories", "false")).lower() == "true"
    ]
    target_accuracy = ratio(
        sum(0.5 * row.get("memory_accuracy_score", 0) for row in target), len(target)
    )
    weighted_accuracy = ratio(
        sum(0.5 * row.get("memory_accuracy_score", 0) for row in accuracy), len(accuracy)
    )
    extraction_f1 = None
    if recall is not None and target_accuracy is not None:
        extraction_f1 = (
            0.0
            if recall + target_accuracy == 0
            else 2 * recall * target_accuracy / (recall + target_accuracy)
        )

    valid_updates = [
        row
        for row in updates
        if row.get("memory_update_type") in {"Correct", "Hallucination", "Omission", "Other"}
    ]
    update_counts = {
        label: sum(row.get("memory_update_type") == label for row in updates)
        for label in ("Correct", "Hallucination", "Omission", "Other")
    }
    return {
        "memory_integrity": {
            "recall_all": recall,
            "weighted_recall_all": weighted_recall,
            "interference_accuracy_all": interference_accuracy,
            "memory_num": len(normal),
            "valid_num": len(valid_normal),
            "interference_num": len(interference),
            "interference_valid_num": len(valid_interference),
        },
        "memory_accuracy": {
            "target_accuracy_all": target_accuracy,
            "weighted_accuracy_all": weighted_accuracy,
            "memory_num": len(accuracy),
            "valid_num": len(valid_accuracy),
            "target_memory_num": len(target),
        },
        "memory_extraction_f1": extraction_f1,
        "memory_update": {
            "update_num": len(updates),
            "valid_num": len(valid_updates),
            "counts": update_counts,
            "correct_ratio_all": ratio(update_counts["Correct"], len(updates)),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--users", type=int, default=1)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    upstream_eval = Path(args.upstream).resolve() / "eval"
    sys.path.insert(0, str(upstream_eval))
    import evaluation  # type: ignore
    import eval_tools  # type: ignore
    import llms  # type: ignore

    # The official parser accepts only fenced JSON. DeepSeek's OpenAI-compatible
    # endpoint commonly returns the same requested object as bare JSON. Keep the
    # official prompts and rubric unchanged, but make transport parsing provider
    # neutral so a correct response is not retried until timeout.
    def compatible_json_request(prompt: str) -> dict[str, Any]:
        raw = llms.llm_request(prompt).strip()
        fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
        if fenced:
            raw = fenced.group(1)
        else:
            start, end = raw.find("{"), raw.rfind("}")
            if start < 0 or end < start:
                raise ValueError("No JSON object found in model output")
            raw = raw[start : end + 1]
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("Judge output must be a JSON object")
        return parsed

    eval_tools.llm_request_for_json = compatible_json_request
    # Upstream uses process pools. On Windows each child imports the unpatched
    # provider parser again and duplicates the Python runtime. The workload is
    # HTTP-bound, so a bounded thread pool preserves process_user's scheduling
    # semantics while keeping the compatibility shim and memory footprint local.
    evaluation.ProcessPoolExecutor = ThreadPoolExecutor
    process_user = evaluation.process_user

    combined: dict[str, list[dict[str, Any]]] = {
        "memory_integrity_records": [],
        "memory_accuracy_records": [],
        "memory_update_records": [],
        "question_answering_records": [],
    }
    for index, user in enumerate(iter_jsonl(Path(args.input).resolve()), 1):
        if index > args.users:
            break
        result = process_user(index, user, max_workers=max(1, min(args.workers, 16)))
        for key in combined:
            combined[key].extend(result.get(key, []))

    payload = {"overall_score": aggregate(combined), **combined}
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload["overall_score"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
