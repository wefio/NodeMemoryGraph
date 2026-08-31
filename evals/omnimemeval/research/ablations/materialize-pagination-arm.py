"""Materialize a retrieval-ablation arm as an OmniMemEval search artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def render_session(date: str, session: list[dict[str, str]]) -> str:
    turns = "\n".join(f"{turn['role']}: {turn['content']}" for turn in session)
    return f"Date: {date}\n{turns}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--ranking", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--route", default="combined_then_qpp2")
    parser.add_argument("--cutoff", type=int, required=True)
    args = parser.parse_args()

    rows = {
        row["question_id"]: row
        for row in json.loads(args.data.read_text(encoding="utf-8"))
    }
    report = json.loads(args.ranking.read_text(encoding="utf-8"))
    output: dict[str, list[dict[str, object]]] = {}

    for index, detail in enumerate(report["details"]):
        row = rows[detail["question_id"]]
        sessions = {
            session_id: render_session(row["haystack_dates"][position], session)
            for position, (session_id, session) in enumerate(
                zip(row["haystack_session_ids"], row["haystack_sessions"], strict=True)
            )
        }
        selected = detail["selected_sessions"][args.route][: args.cutoff]
        evidence = [
            f"{turn['role']} : {turn['content']}"
            for session_id in row["answer_session_ids"]
            for turn in row["haystack_sessions"][row["haystack_session_ids"].index(session_id)]
        ]
        user_id = f"lme_exper_user_nmg_{args.version}_{index}"
        output[user_id] = [{
            "question": row["question"],
            "category": row["question_type"],
            "date": row["question_date"],
            "golden_answer": row["answer"],
            "answer_evidences": evidence,
            "search_context": "Conversation memories:\n\n" + "\n\n".join(
                sessions[session_id] for session_id in selected
            ),
            "search_duration_ms": 0.0,
            "status": "success",
        }]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(output)} questions to {args.output}")


if __name__ == "__main__":
    main()
