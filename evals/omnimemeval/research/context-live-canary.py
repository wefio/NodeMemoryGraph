"""Exploratory live canary: real main-model exposure x 3 context arms (F1/F2/P1 work, context-live-loop #000084).

Replays an existing OmniMemEval LoCoMo search artifact's rendered retrieval
context into the OFFICIAL locomo answer+grader path (locomo_response /
locomo_grader via create_async_openai_client) for a tiny fixed set of real
questions, under three fixed arms:

  - none            : context = "" (no memory context at all)
  - cue             : context = cueText (one short literal, default CONTEXT_CUE)
  - retrieve-replay : context = the (group, question)'s full non-empty search
                      artifact context (<= maxContextChars), already truncated

Only the search context is REPLAYED from the artifact; no live retrieval runs.
So the retrieve arm is metadata-marked source=replayed-context / retrievalLive=false;
no retrieval cost is observable and no executor call count is fabricated.

This is a CANARY: it proves real model exposure is wired end to end through the
official grader with exact create-boundary capture. It is NOT an independent
effectiveness claim, does NOT generate training/admission labels, and does not
substitute for a benchmark. It never prints env values / secrets.

Run (dry):   python evals/omnimemeval/research/context-live-canary.py --config <cfg.json> --dry-run
Run (live):  same without --dry-run (uses bge-venv python; official modules are
             resolved from the gitignored OmniMemEval scripts dir, never edited).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
import types
from datetime import datetime, timezone
from pathlib import Path

# Matches src/lab/context-executor.ts CONTEXT_CUE literal (the canary reuses the
# same cue the executor would emit; main may override via config cueText).
DEFAULT_CUE_TEXT = (
    "Check the current task against its acceptance criteria and available evidence."
)

ARMS = ("none", "cue", "retrieve-replay")


# --------------------------------------------------------------------------- #
# Pure helpers (importable / testable with NO official/gitignored imports and
# NO network — used by both --dry-run and the no-network test).
# --------------------------------------------------------------------------- #
def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def unique_run_dir(output_dir: str, output_base: str) -> Path:
    """A fresh per-run directory. Never reuses/overwrites an existing one."""
    base = Path(output_dir)
    base.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    run_dir = base / f"{output_base}-{ts}"
    if run_dir.exists():
        # Collision on same-timestamp run: refuse to reuse an existing dir.
        raise FileExistsError(f"run dir already exists (refusing to overwrite): {run_dir}")
    run_dir.mkdir(parents=False)
    return run_dir


def load_config(config_path: str) -> dict:
    with open(config_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    required = {
        "checkout",
        "source",
        "searchFile",
        "datasetFile",
        "outputDir",
    }
    missing = required - set(cfg)
    if missing:
        raise ValueError(f"config missing keys: {sorted(missing)}")
    cfg.setdefault("outputBase", "context-live-canary")
    cfg.setdefault("maxContextChars", 12000)
    cfg.setdefault("groups", 3)
    cfg.setdefault("timeoutSeconds", 120)
    cfg.setdefault("cueText", DEFAULT_CUE_TEXT)
    # Enforce the fixed upper bounds from the coordination contract.
    assert int(cfg["maxContextChars"]) == 12000, "maxContextChars must be 12000"
    assert int(cfg["groups"]) == 3, "groups must be 3"
    assert int(cfg["timeoutSeconds"]) <= 120, "timeoutSeconds must be <= 120"
    for key in ("searchFile", "datasetFile", "outputDir"):
        cfg[key] = os.path.abspath(cfg[key])
    return cfg


def _load_dataset(dataset_file: str) -> dict[int, dict[str, dict]]:
    """dataset index -> {question -> {answer, category}} from locomo10.json."""
    data = json.load(open(dataset_file, encoding="utf-8"))
    out: dict[int, dict[str, dict]] = {}
    for idx, item in enumerate(data):
        by_q: dict[str, dict] = {}
        for qa in item.get("qa", []):
            q = str(qa.get("question", "")).strip()
            if q:
                by_q[q] = {
                    "answer": qa.get("answer"),
                    "category": str(qa.get("category", "")),
                }
        out[idx] = by_q
    return out


def _load_search(search_file: str) -> dict[str, list[dict]]:
    return json.load(open(search_file, encoding="utf-8"))


def select_questions(
    search: dict[str, list[dict]],
    dataset: dict[int, dict[str, dict]],
    *,
    groups: int = 3,
    max_context_chars: int = 12000,
) -> list[dict]:
    """Deterministic selection: in search-file order, for the first `groups`
    distinct locomo_exp_user_N groups, take the ORDER-FIRST question whose
    context is non-empty and <= max_context_chars and whose dataset category is
    not the excluded '5' (cat5). Selection is by order/rule, NEVER by score.
    Returns [{group, groupKey, question, gold_answer, category, context}].
    """
    # keys sorted by their numeric suffix so group order is deterministic.
    ordered_keys = []
    for key in search:
        if key.startswith("locomo_exp_user_") and key[len("locomo_exp_user_") :].isdigit():
            ordered_keys.append((int(key[len("locomo_exp_user_") :]), key))
    ordered_keys.sort(key=lambda t: t[0])
    chosen: list[dict] = []
    for group_idx, key in ordered_keys:
        rows = search[key]
        group_qa = dataset.get(group_idx, {})
        picked = None
        for row in rows:  # order-first
            if str(row.get("status", "")) != "success":
                continue
            q = str(row.get("query", "")).strip()
            ctx = str(row.get("context", "") or "")
            if not q or not ctx:
                continue
            if len(ctx) > max_context_chars:
                continue
            qa = group_qa.get(q)
            if qa is None or qa.get("category") == "5":
                continue  # exclude cat5
            picked = {
                "group": group_idx,
                "groupKey": key,
                "question": q,
                "gold_answer": qa.get("answer"),
                "category": qa.get("category"),
                "context": ctx,
            }
            break
        if picked is not None:
            chosen.append(picked)
        if len(chosen) >= groups:
            break
    return chosen


def arm_context(arm: str, retrieve_context: str, cue_text: str) -> str:
    """Per-arm context for the SAME question. none/cue carry no retrieval content."""
    if arm == "none":
        return ""
    if arm == "cue":
        return cue_text
    if arm == "retrieve-replay":
        return retrieve_context
    raise ValueError(f"unknown arm: {arm}")


def arm_metadata(arm: str) -> dict:
    if arm == "retrieve-replay":
        return {"action": "retrieve", "source": "replayed-context", "retrievalLive": False}
    return {"action": arm, "source": None, "retrievalLive": False}


# --------------------------------------------------------------------------- #
# Official-module bridge (live only). Resolved from the gitignored OmniMemEval
# scripts dir; the upstream modules are imported, never edited.
# --------------------------------------------------------------------------- #
def _official_scripts_root(search_file: str) -> str:
    """Walk up from the artifact to the OmniMemEval/scripts dir that owns
    locomo_responses.py (the gitignored upstream clone)."""
    cur = os.path.dirname(os.path.abspath(search_file))
    for _ in range(12):
        probe = os.path.join(cur, "scripts", "locomo", "locomo_responses.py")
        if os.path.isfile(probe):
            return os.path.join(cur, "scripts")
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    raise FileNotFoundError("could not locate OmniMemEval/scripts owning locomo_responses.py")


class _CompletionsCapture:
    """Client-side proxy capturing the real create() boundary (messages sent,
    response content, usage, hash) WITHOUT modifying the upstream client."""

    def __init__(self, real_completions, *, timeout_seconds: float):
        self._real = real_completions
        self._timeout = timeout_seconds
        self.calls: list[dict] = []

    async def create(self, *args, **kwargs):
        start = time.monotonic()
        resp = await asyncio.wait_for(
            self._real.create(*args, **kwargs), timeout=self._timeout
        )
        messages = kwargs.get("messages")
        model = kwargs.get("model")
        message = (resp.choices[0].message if getattr(resp, "choices", None) else None)
        content = getattr(message, "content", None) or ""
        usage = getattr(resp, "usage", None)
        usage_dict = None
        if usage is not None:
            usage_dict = {
                "prompt_tokens": getattr(usage, "prompt_tokens", None),
                "completion_tokens": getattr(usage, "completion_tokens", None),
                "total_tokens": getattr(usage, "total_tokens", None),
            }
        payload = {"model": model, "messages": messages}
        call = {
            "model": model,
            "messages": messages,
            "messagesHash": sha256_text(json.dumps(payload, sort_keys=True)),
            "content": content,
            "usage": usage_dict,  # None if the provider returned none; keep missing, not 0
            "durationMs": round((time.monotonic() - start) * 1000, 3),
            "error": None,
        }
        self.calls.append(call)
        return resp


class _ClientProxy:
    """Minimal llm_client stand-in: exposes .chat.completions.create proxied."""

    def __init__(self, real_tracked, *, timeout_seconds: float):
        self.chat = types.SimpleNamespace(
            completions=_CompletionsCapture(
                real_tracked.chat.completions, timeout_seconds=timeout_seconds
            )
        )
        self._tracked = real_tracked


def _load_official(search_file: str, timeout_seconds: float):
    root = _official_scripts_root(search_file)
    for sub in ("", "locomo", "utils", "client_factory"):
        p = os.path.join(root, sub) if sub else root
        if p not in sys.path:
            sys.path.insert(0, p)
    from locomo_responses import locomo_response  # noqa: PLC0415
    from locomo_eval import locomo_grader  # noqa: PLC0415
    from utils.llm_client import create_async_openai_client  # noqa: PLC0415

    # Same official client+model for both answer and judge (the coordination
    # contract: config introduces no separate judge provider; both use 'ANSWER').
    tracked, model_name = create_async_openai_client("ANSWER")
    proxy = _ClientProxy(tracked, timeout_seconds=timeout_seconds)
    return locomo_response, locomo_grader, proxy, model_name


def _load_env_file(env_file: str | None) -> None:
    if not env_file:
        return
    with open(env_file, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if key:
                os.environ.setdefault(key, value)


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #
def append_record(run_dir: Path, record: dict) -> None:
    with open(run_dir / "records.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _metadata_payload(cfg: dict, chosen: list[dict], *, dry_run: bool) -> dict:
    return {
        "checkout": cfg.get("checkout"),
        "source": cfg.get("source"),
        "retrievalLive": False,
        "mode": "dry-run" if dry_run else "live",
        "selectionRule": (
            "per locomo_exp_user_N group, order-first question whose search "
            "context is non-empty and <= maxContextChars, dataset category != '5' "
            "(cat5 excluded); never selected by score; first `groups` groups"
        ),
        "chosen": [
            {
                "group": c["group"],
                "groupKey": c["groupKey"],
                "question": c["question"],
                "category": c["category"],
                "contextLen": len(c["context"]),
            }
            for c in chosen
        ],
        "arms": list(ARMS),
    }


# --------------------------------------------------------------------------- #
# Live orchestration
# --------------------------------------------------------------------------- #
async def run_selected(cfg: dict, chosen: list[dict], run_dir: Path) -> None:
    if not chosen:
        raise RuntimeError("no qualifying questions selected")
    locomo_response, locomo_grader, proxy, model_name = _load_official(
        cfg["searchFile"], float(cfg["timeoutSeconds"])
    )
    cue_text = cfg.get("cueText", DEFAULT_CUE_TEXT)
    total_answers = 0
    total_judges = 0
    for item in chosen:
        retrieve_context = item["context"]
        for arm in ARMS:
            context = arm_context(arm, retrieve_context, cue_text)
            question = item["question"]
            gold = item["gold_answer"]
            base = {
                "checkout": cfg.get("checkout"),
                "source": cfg.get("source"),
                "task": cfg.get("source"),
                "group": item["group"],
                "groupKey": item["groupKey"],
                "question": question,
                "arm": arm,
                **arm_metadata(arm),
                "contextLen": len(context),
                "context": context,
                "gold_answer": gold,
                "category": item["category"],
                "model": model_name,
                "totalDurationMs": 0,
            }
            # --- answer ---
            record = dict(base)
            answer_err = None
            try:
                answer, _messages = await locomo_response(
                    item["groupKey"], proxy, model_name, context, question
                )
                capture = proxy.chat.completions.calls[-1]
                record["answer"] = answer
                record["messages"] = capture["messages"]
                record["messagesHash"] = capture["messagesHash"]
                record["usage"] = capture["usage"]  # None stays None (no zero-fill)
                record["answerDurationMs"] = capture["durationMs"]
                record["status"] = "answered"
                total_answers += 1
            except Exception as exc:  # noqa: BLE001 - record and continue
                answer_err = f"{type(exc).__name__}: {exc}"
                record.update(
                    status="error",
                    stage="answer",
                    error=answer_err,
                    answer=None,
                    messages=None,
                    messagesHash=None,
                    usage=None,
                )
            append_record(run_dir, record)
            # --- judge (only when an answer exists) ---
            if answer_err is None:
                jrec = dict(base)
                try:
                    judged = await locomo_grader(
                        proxy,
                        model_name,
                        question,
                        str(gold),
                        record["answer"],
                        asyncio.Semaphore(1),
                    )
                    capture = proxy.chat.completions.calls[-1]
                    jrec["messages"] = capture["messages"]
                    jrec["messagesHash"] = capture["messagesHash"]
                    jrec["usage"] = capture["usage"]
                    jrec["judged"] = bool(judged)
                    jrec["judgeDurationMs"] = capture["durationMs"]
                    jrec["status"] = "judged"
                    total_judges += 1
                except Exception as exc:  # noqa: BLE001 - record and continue
                    jrec.update(
                        status="error",
                        stage="judge",
                        error=f"{type(exc).__name__}: {exc}",
                        judged=None,
                        messages=None,
                        messagesHash=None,
                        usage=None,
                    )
                append_record(run_dir, jrec)
    # Hard cap: 3 groups * 3 arms answers + their judges.
    assert total_answers <= 9, "exceeded 9-answer cap"
    assert total_judges <= 9, "exceeded 9-judge cap"
    # final summary record (no env/secrets)
    append_record(
        run_dir,
        {
            "kind": "summary",
            "answers": total_answers,
            "judges": total_judges,
            "model": model_name,
            "status": "complete",
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cfg = load_config(args.config)
    _load_env_file(cfg.get("envFile"))
    search = _load_search(cfg["searchFile"])
    dataset = _load_dataset(cfg["datasetFile"])
    chosen = select_questions(
        search,
        dataset,
        groups=int(cfg["groups"]),
        max_context_chars=int(cfg["maxContextChars"]),
    )
    run_dir = unique_run_dir(cfg["outputDir"], cfg["outputBase"])
    meta = _metadata_payload(cfg, chosen, dry_run=args.dry_run)
    with open(run_dir / "metadata.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    if args.dry_run:
        print(f"dry-run run dir: {run_dir}")
        print(f"selected {len(chosen)} questions")
        for c in chosen:
            print(
                f"  group={c['group']} ({c['groupKey']}) q={c['question']!r} "
                f"cat={c['category']} contextLen={len(c['context'])}"
            )
        return 0

    asyncio.run(run_selected(cfg, chosen, run_dir))
    print(f"live canary run dir: {run_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
