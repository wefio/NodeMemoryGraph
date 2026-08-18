from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from skillopt.model import chat_target

_ACTIONS = {"answer", "expand", "stop"}


def _prompt(item: dict) -> str:
    state = item.get("state") or {}
    return (
        "You are controlling progressive recall for an external memory system.\n"
        "Use the supplied policy and observable retrieval state only. Do not answer "
        "the underlying user question and do not invent memories.\n\n"
        f"Latest recall query: {item.get('query', '')}\n"
        f"Observable retrieval state:\n{json.dumps(state, ensure_ascii=False, sort_keys=True)}\n\n"
        "Return exactly one JSON object with this schema and no other text:\n"
        '{"recall_action":"answer|expand|stop","fold_noise":true|false}'
    )


def _parse(text: str) -> dict | None:
    candidate = (text or "").strip()
    if candidate.startswith("```"):
        lines = candidate.splitlines()
        candidate = "\n".join(lines[1:-1]).strip() if len(lines) >= 3 else ""
    try:
        value = json.loads(candidate)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    action = value.get("recall_action")
    fold_noise = value.get("fold_noise")
    if action not in _ACTIONS or not isinstance(fold_noise, bool):
        return None
    return {"recall_action": action, "fold_noise": fold_noise}


def _rollout_one(item: dict, skill_content: str, prediction_dir: Path,
                 max_completion_tokens: int) -> dict:
    user = _prompt(item)
    prediction, usage = chat_target(
        system=skill_content,
        user=user,
        max_completion_tokens=max(1, int(max_completion_tokens)),
    )
    parsed = _parse(prediction)
    expected = item.get("expected") or {}
    action_ok = parsed is not None and parsed["recall_action"] == expected.get("recall_action")
    noise_ok = parsed is not None and parsed["fold_noise"] == expected.get("fold_noise")
    hard = int(action_ok and noise_ok)
    # Action selection is the safety-critical decision. Noise folding receives
    # partial credit, but SkillOpt's default hard validation gate remains the
    # promotion criterion.
    soft = (0.75 if action_ok else 0.0) + (0.25 if noise_ok else 0.0)
    task_dir = prediction_dir / str(item["id"])
    task_dir.mkdir(parents=True, exist_ok=True)
    conversation = [
        {"role": "system", "content": skill_content},
        {"role": "user", "content": user},
        {"role": "assistant", "content": prediction},
    ]
    (task_dir / "conversation.json").write_text(
        json.dumps(conversation, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {
        "id": str(item["id"]),
        "hard": hard,
        "soft": soft,
        "predicted_answer": prediction,
        "expected_decision": expected,
        "parsed_decision": parsed,
        "question": item.get("query", ""),
        "task_description": "Choose the next NMG progressive-recall action.",
        "task_type": item.get("task_type", "nmg_policy"),
        "target_system_prompt": skill_content,
        "target_user_prompt": user,
        "n_turns": 1,
        "usage": usage,
    }


def run_batch(*, items: list[dict], skill_content: str, out_root: str,
              workers: int = 4, max_completion_tokens: int = 256) -> list[dict]:
    prediction_dir = Path(out_root, "predictions")
    prediction_dir.mkdir(parents=True, exist_ok=True)
    worker_count = max(1, min(int(workers), 16, len(items) or 1))
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        results = list(pool.map(
            lambda item: _rollout_one(
                item, skill_content, prediction_dir, max_completion_tokens
            ),
            items,
        ))
    Path(out_root, "rollouts.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return results
