"""Paired LongMemEval answer/judge probe over saved retrieval rankings.

The retrieval ablation ranks whole sessions.  To avoid injecting verbose
assistant generations, this probe renders timestamped user turns only.  It
uses OmniMemEval's official answer and judge prompts and never exposes gold
answers to the answer model.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path


OMNI = Path(__file__).resolve().parents[2] / ".benchmarks" / "official" / "OmniMemEval"
sys.path.insert(0, str(OMNI / "scripts"))

from longmemeval.lme_eval import lme_grader  # noqa: E402
from longmemeval.lme_responses import lme_response  # noqa: E402
from utils.env import load_env  # noqa: E402
from utils.llm_client import create_async_openai_client  # noqa: E402
from utils.token_tracker import get_tracker  # noqa: E402


def render_context(row: dict, session_ids: list[str]) -> str:
    sessions = dict(zip(row["haystack_session_ids"], row["haystack_sessions"]))
    dates = dict(zip(row["haystack_session_ids"], row["haystack_dates"]))
    blocks: list[str] = []
    for session_id in session_ids:
        turns = [
            f"User: {turn['content']}"
            for turn in sessions[session_id]
            if turn.get("role") == "user"
        ]
        blocks.append(f"Date: {dates[session_id]}\n" + "\n".join(turns))
    return "\n\n---\n\n".join(blocks)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--old-ranking", type=Path, required=True)
    parser.add_argument("--new-ranking", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=64)
    args = parser.parse_args()

    load_env()
    answer_client, answer_model = create_async_openai_client("ANSWER")
    judge_client, judge_model = create_async_openai_client("EVAL")
    rows = {
        row["question_id"]: row
        for row in json.loads(args.data.read_text(encoding="utf-8"))
    }
    old = json.loads(args.old_ranking.read_text(encoding="utf-8"))
    new = json.loads(args.new_ranking.read_text(encoding="utf-8"))
    old_details = {row["question_id"]: row for row in old["details"]}
    new_details = {row["question_id"]: row for row in new["details"]}
    arms = {
        "baseline_top20": lambda q: new_details[q]["selected_sessions"]["baseline"][:20],
        "legacy_1plus2_top20": lambda q: old_details[q]["selected_sessions"]["combined_then_qpp2"][:20],
        "rrf_combined_top25": lambda q: new_details[q]["selected_sessions"]["combined_then_qpp2"][:25],
    }

    results: dict[str, dict] = {}
    if args.output.exists():
        results = json.loads(args.output.read_text(encoding="utf-8")).get("results", {})
    semaphore = asyncio.Semaphore(args.workers)

    async def evaluate(question_id: str, arm: str, selected: list[str]) -> None:
        key = f"{question_id}:{arm}"
        if key in results and "correct" in results[key]:
            return
        row = rows[question_id]
        context = render_context(row, selected)
        async with semaphore:
            started = time.perf_counter()
            answer, _ = await lme_response(
                answer_client,
                answer_model,
                context,
                row["question"],
                row["question_date"],
            )
            answer_ms = (time.perf_counter() - started) * 1000
            correct = await lme_grader(
                judge_client,
                judge_model,
                row["question"],
                row["answer"],
                answer,
                semaphore=asyncio.Semaphore(1),
            )
        results[key] = {
            "question_id": question_id,
            "arm": arm,
            "answer": answer,
            "golden_answer": row["answer"],
            "correct": correct,
            "selected_sessions": selected,
            "context_characters": len(context),
            "answer_duration_ms": answer_ms,
        }

    tasks = [
        evaluate(question_id, arm, selector(question_id))
        for question_id in sorted(new_details)
        for arm, selector in arms.items()
    ]
    await asyncio.gather(*tasks)
    summary = {}
    for arm in arms:
        records = [record for record in results.values() if record["arm"] == arm]
        correct = sum(bool(record["correct"]) for record in records)
        summary[arm] = {
            "questions": len(records),
            "correct": correct,
            "accuracy": correct / max(1, len(records)),
            "mean_context_characters": sum(r["context_characters"] for r in records) / max(1, len(records)),
            "mean_answer_duration_ms": sum(r["answer_duration_ms"] for r in records) / max(1, len(records)),
        }
    report = {
        "method": {
            "answer_prompt": "official OmniMemEval LongMemEval",
            "judge_prompt": "official OmniMemEval LongMemEval",
            "context": "timestamped user turns from ranked sessions; assistant turns excluded",
            "answer_model": answer_model,
            "judge_model": judge_model,
        },
        "summary": summary,
        "tokens": get_tracker().summary(),
        "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": summary, "tokens": report["tokens"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    asyncio.run(main())
