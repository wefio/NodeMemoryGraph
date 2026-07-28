"""Build a PersonaMem ask-to-forget answer-stage ablation.

This is deliberately not an alternative PersonaMem scorer. It reuses a
completed official NMG search artifact and keeps only ``ask_to_forget`` rows.
It can either preserve the backend's context unchanged (``--filter-only``) or
add the nearest explicit user revocation as a ``[forget]`` record. The official
PersonaMem response and metric scripts consume the resulting file.

The utility answers one narrow question cheaply before a full memory-backend
rerun: can the fixed reader use an explicit logical-forgetting representation?
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

FORGET_RE = re.compile(
    r"^(?:please\s+)?"
    r"(?:i\s+(?:want|need|would\s+like)\s+you\s+to\s+)?"
    r"(?:forget|erase|remove|delete)\s+"
    r"(?:about\s+|that\s+)?(.+?)\s*[.!?]*$",
    re.IGNORECASE,
)
OLD_GUIDANCE = (
    "[NMG retrieval guidance] Treat relevant user facts, preferences, constraints, "
    "tools, and prior experiences as evidence for a personalized answer. Apply them "
    "to the current request even when the final answer did not appear verbatim in "
    "history. Do not invent unsupported user details."
)
TAG_GUIDANCE = (
    "[NMG retrieval guidance] Treat relevant user facts, preferences, constraints, "
    "tools, and prior experiences as evidence for a personalized answer. Apply them "
    "to the current request even when the final answer did not appear verbatim in "
    "history. A line beginning with [forget] is a revocation boundary, not an active "
    "fact: do not use or reconstruct that content, and prefer an answer independent "
    "of it. Do not invent unsupported user details."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--chat-dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    parser.add_argument("--top-tags", type=int, default=1)
    parser.add_argument("--filter-only", action="store_true")
    return parser.parse_args()


def persona_id(path: Path) -> int:
    match = re.search(r"_persona(\d+)\.json$", path.name)
    if not match:
        raise ValueError(f"cannot parse persona id from {path}")
    return int(match.group(1))


def load_revocations(chat_dir: Path) -> dict[int, list[str]]:
    result: dict[int, list[str]] = {}
    for path in chat_dir.glob("*.json"):
        history = json.loads(path.read_text(encoding="utf-8"))["chat_history"]
        targets: list[str] = []
        for message in history:
            if message.get("role") != "user":
                continue
            match = FORGET_RE.match(str(message.get("content", "")).strip())
            if match:
                targets.append(match.group(1).strip())
        result[persona_id(path)] = targets
    return result


def main() -> None:
    args = parse_args()
    if args.top_tags < 1:
        raise ValueError("--top-tags must be at least 1")

    source = json.loads(args.source.read_text(encoding="utf-8"))
    rows = [
        entries[0]
        for entries in source.values()
        if isinstance(entries, list)
        and len(entries) == 1
        and entries[0].get("category") == "ask_to_forget"
    ]
    if not args.filter_only and args.chat_dir is None:
        raise ValueError("--chat-dir is required unless --filter-only is used")
    revocations = load_revocations(args.chat_dir) if args.chat_dir else {}
    if args.filter_only:
        model = None
        np = None
    else:
        import numpy as np
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer(args.model)

    by_persona: dict[int, list[dict]] = {}
    for row in rows:
        by_persona.setdefault(int(row["persona_id"]), []).append(row)

    output: dict[str, list[dict]] = {}
    tagged = 0
    for pid, persona_rows in by_persona.items():
        if args.filter_only:
            for row in persona_rows:
                updated = dict(row)
                old_key = str(row["key"])
                row_index = int(row["row_idx"])
                new_key = f"pm_exper_user_{row_index}_{args.version}"
                updated["key"] = new_key
                updated["user_id"] = new_key
                updated["ablation_source_key"] = old_key
                updated["ablation"] = "ask_to_forget_filter_only"
                output[new_key] = [updated]
            continue

        targets = revocations.get(pid, [])
        if not targets:
            raise ValueError(f"persona {pid} has ask_to_forget rows but no revocations")
        assert model is not None
        assert np is not None
        target_vectors = model.encode(
            targets, normalize_embeddings=True, convert_to_numpy=True
        )
        question_vectors = model.encode(
            [str(row["question"]) for row in persona_rows],
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        similarities = np.asarray(question_vectors) @ np.asarray(target_vectors).T

        for row, scores in zip(persona_rows, similarities, strict=True):
            count = min(args.top_tags, len(targets))
            indices = np.argsort(-scores, kind="stable")[:count]
            tags = "\n".join(f"[forget] {targets[int(index)]}" for index in indices)
            updated = dict(row)
            old_key = str(row["key"])
            row_index = int(row["row_idx"])
            new_key = f"pm_exper_user_{row_index}_{args.version}"
            updated["key"] = new_key
            updated["user_id"] = new_key
            context = str(updated.get("search_context", "")).replace(
                OLD_GUIDANCE, TAG_GUIDANCE
            )
            updated["search_context"] = f"{context.rstrip()}\n{tags}\n"
            updated["ablation_source_key"] = old_key
            updated["ablation"] = "nearest_explicit_forget_tag"
            output[new_key] = [updated]
            tagged += 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "rows": len(rows),
                "tagged": tagged,
                "personas": len(by_persona),
                "top_tags": args.top_tags,
                "filter_only": args.filter_only,
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
