# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "sentence-transformers",
# ]
# ///
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
    parser.add_argument(
        "--min-similarity",
        type=float,
        default=-1.0,
        help="Minimum cosine similarity required to add a synthetic tag.",
    )
    parser.add_argument(
        "--require-forget-over-active",
        action="store_true",
        help="Add a tag only when it is closer than every remaining active user message.",
    )
    parser.add_argument("--filter-only", action="store_true")
    parser.add_argument(
        "--category",
        default="ask_to_forget",
        help="Category to retain, or 'all' to retain every row.",
    )
    parser.add_argument(
        "--strip-forget-tags",
        action="store_true",
        help="Remove [forget] rows and restore the pre-revocation guidance.",
    )
    parser.add_argument(
        "--max-existing-tags",
        type=int,
        help="In filter-only mode, retain at most this many existing [forget] rows.",
    )
    parser.add_argument(
        "--min-existing-similarity",
        type=float,
        help="In filter-only mode, drop existing tags below forget_tag_similarity.",
    )
    return parser.parse_args()


def persona_id(path: Path) -> int:
    match = re.search(r"_persona(\d+)\.json$", path.name)
    if not match:
        raise ValueError(f"cannot parse persona id from {path}")
    return int(match.group(1))


def forget_terms(text: str) -> set[str]:
    stop = {
        "about", "after", "also", "and", "are", "been", "being", "but", "can",
        "did", "does", "for", "from", "had", "has", "have", "into", "that",
        "the", "their", "them", "they", "this", "was", "were", "with", "would",
        "your", "you", "feel", "felt",
    }
    return {
        term
        for term in re.findall(r"[\w]+", text.lower(), flags=re.UNICODE)
        if len(term) >= 3 and term not in stop
    }


def matches_forget_target(candidate: str, target: str) -> bool:
    target_terms = forget_terms(target)
    candidate_terms = forget_terms(candidate)
    shared = len(target_terms & candidate_terms)
    return (
        shared >= 2
        and (
            shared / max(1, len(target_terms)) >= 0.5
            or shared / max(1, len(candidate_terms)) >= 0.6
        )
    )


def load_memory_state(chat_dir: Path) -> dict[int, tuple[list[str], list[str]]]:
    result: dict[int, tuple[list[str], list[str]]] = {}
    for path in chat_dir.glob("*.json"):
        history = json.loads(path.read_text(encoding="utf-8"))["chat_history"]
        targets: list[str] = []
        active: list[str] = []
        for message in history:
            if message.get("role") != "user":
                continue
            content = str(message.get("content", "")).strip()
            match = FORGET_RE.match(content)
            if match:
                target = match.group(1).strip()
                active = [
                    candidate
                    for candidate in active
                    if not matches_forget_target(candidate, target)
                ]
                targets.append(target)
            elif content:
                active.append(content)
        result[persona_id(path)] = (targets, active)
    return result


def project_existing_tags(
    context: str,
    *,
    maximum: int | None,
    similarity: float | None,
    minimum_similarity: float | None,
) -> tuple[str, int]:
    keep = maximum
    if minimum_similarity is not None and (
        similarity is None or similarity < minimum_similarity
    ):
        keep = 0
    retained = 0
    lines: list[str] = []
    for line in context.splitlines():
        if not line.lstrip().startswith("[forget]"):
            lines.append(line)
            continue
        if keep is None or retained < keep:
            lines.append(line)
            retained += 1
    projected = "\n".join(lines)
    if retained == 0:
        projected = projected.replace(TAG_GUIDANCE, OLD_GUIDANCE)
    return projected, retained


def main() -> None:
    args = parse_args()
    if args.top_tags < 1:
        raise ValueError("--top-tags must be at least 1")
    if args.strip_forget_tags and not args.filter_only:
        raise ValueError("--strip-forget-tags requires --filter-only")
    if args.max_existing_tags is not None and args.max_existing_tags < 0:
        raise ValueError("--max-existing-tags must be non-negative")
    if (
        (args.max_existing_tags is not None or args.min_existing_similarity is not None)
        and not args.filter_only
    ):
        raise ValueError("existing-tag projection requires --filter-only")

    source = json.loads(args.source.read_text(encoding="utf-8"))
    rows = []
    for entries in source.values():
        if not isinstance(entries, list) or len(entries) != 1:
            continue
        row = entries[0]
        if args.category == "all" or row.get("category") == args.category:
            rows.append(row)
    if not args.filter_only and args.chat_dir is None:
        raise ValueError("--chat-dir is required unless --filter-only is used")
    memory_state = load_memory_state(args.chat_dir) if args.chat_dir else {}
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
                if (
                    args.strip_forget_tags
                    or args.max_existing_tags is not None
                    or args.min_existing_similarity is not None
                ):
                    context = str(updated.get("search_context", ""))
                    maximum = 0 if args.strip_forget_tags else args.max_existing_tags
                    context, retained = project_existing_tags(
                        context,
                        maximum=maximum,
                        similarity=(
                            float(updated["forget_tag_similarity"])
                            if "forget_tag_similarity" in updated
                            else None
                        ),
                        minimum_similarity=args.min_existing_similarity,
                    )
                    updated["search_context"] = context
                    updated["projected_forget_tags"] = retained
                    tagged += int(retained > 0)
                updated["ablation_source_key"] = old_key
                updated["ablation"] = (
                    "strip_forget_tags"
                    if args.strip_forget_tags
                    else (
                        "selective_forget_projection"
                        if args.max_existing_tags is not None
                        or args.min_existing_similarity is not None
                        else "category_filter_only"
                    )
                )
                output[new_key] = [updated]
            continue

        targets, active = memory_state.get(pid, ([], []))
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
        if args.require_forget_over_active and active:
            active_vectors = model.encode(
                active, normalize_embeddings=True, convert_to_numpy=True
            )
            active_similarities = (
                np.asarray(question_vectors) @ np.asarray(active_vectors).T
            )
            max_active = np.max(active_similarities, axis=1)
        else:
            max_active = np.full(len(persona_rows), -1.0)

        for row, scores, active_score in zip(
            persona_rows, similarities, max_active, strict=True
        ):
            eligible = np.flatnonzero(scores >= args.min_similarity)
            eligible = eligible[np.argsort(-scores[eligible], kind="stable")]
            if (
                args.require_forget_over_active
                and len(eligible) > 0
                and scores[int(eligible[0])] < active_score
            ):
                eligible = np.asarray([], dtype=int)
            count = min(args.top_tags, len(eligible))
            indices = eligible[:count]
            tags = "\n".join(f"[forget] {targets[int(index)]}" for index in indices)
            updated = dict(row)
            old_key = str(row["key"])
            row_index = int(row["row_idx"])
            new_key = f"pm_exper_user_{row_index}_{args.version}"
            updated["key"] = new_key
            updated["user_id"] = new_key
            context = str(updated.get("search_context", ""))
            if len(indices) > 0:
                context = context.replace(OLD_GUIDANCE, TAG_GUIDANCE)
                updated["search_context"] = f"{context.rstrip()}\n{tags}\n"
                updated["forget_tag_similarity"] = float(scores[int(indices[0])])
                tagged += 1
            else:
                updated["search_context"] = context
                updated["forget_tag_similarity"] = float(np.max(scores))
            updated["active_similarity"] = float(active_score)
            updated["forget_active_margin"] = (
                float(np.max(scores)) - float(active_score)
            )
            updated["ablation_source_key"] = old_key
            updated["ablation"] = "nearest_explicit_forget_tag"
            output[new_key] = [updated]

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
                "min_similarity": args.min_similarity,
                "require_forget_over_active": args.require_forget_over_active,
                "filter_only": args.filter_only,
                "category": args.category,
                "strip_forget_tags": args.strip_forget_tags,
                "max_existing_tags": args.max_existing_tags,
                "min_existing_similarity": args.min_existing_similarity,
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
