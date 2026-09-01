"""Matched PersonaMem prompt-layout ablation against the official DeepSeek API.

Both arms contain the same instructions, context, question, and options.  The
static-first arm only moves fixed instruction blocks before the first dynamic
field. Answers are scored locally and are not persisted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from statistics import mean, median

from dotenv import dotenv_values
from openai import AsyncOpenAI


def usage_value(usage: object, name: str) -> int:
    try:
        return max(0, int(getattr(usage, name, 0) or 0))
    except (TypeError, ValueError):
        return 0


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def selected_choice(text: str) -> str | None:
    if "<final_answer>" in text:
        text = text.split("<final_answer>")[-1]
    values = re.findall(r"\(([a-d])\)", text.lower())
    return values[-1] if values else None


async def run_arm(client, model, rows, render_prompt, concurrency, label):
    semaphore = asyncio.Semaphore(concurrency)
    nonce = uuid.uuid4().hex
    latencies = []
    hit_tokens = 0
    miss_tokens = 0
    correct = 0
    outcomes = {}

    async def call(row):
        nonlocal hit_tokens, miss_tokens, correct
        context = f"[prompt-layout-probe={nonce}]\n{row['search_context']}"
        prompt = render_prompt(
            context=context,
            question=row["question"],
            options=row["all_options"],
        )
        async with semaphore:
            started = time.perf_counter()
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                max_tokens=24,
                extra_body={"thinking": {"type": "disabled"}},
            )
            latencies.append((time.perf_counter() - started) * 1000)
            hit_tokens += usage_value(response.usage, "prompt_cache_hit_tokens")
            miss_tokens += usage_value(response.usage, "prompt_cache_miss_tokens")
            answer = response.choices[0].message.content or ""
            choice = selected_choice(answer)
            is_correct = choice == str(row["golden_answer"]).lower().strip("() ")
            correct += is_correct
            outcomes[str(row["key"])] = {"correct": is_correct, "choice": choice}

    started = time.perf_counter()
    await asyncio.gather(*(call(row) for row in rows))
    elapsed = time.perf_counter() - started
    total = hit_tokens + miss_tokens
    return {
        "layout": label,
        "requests": len(rows),
        "accuracy": round(correct / len(rows), 4),
        "wallSeconds": round(elapsed, 3),
        "requestsPerSecond": round(len(rows) / elapsed, 3),
        "latencyMs": {
            "mean": round(mean(latencies), 1),
            "p50": round(median(latencies), 1),
            "p95": round(percentile(latencies, 0.95), 1),
        },
        "cache": {
            "hitTokens": hit_tokens,
            "missTokens": miss_tokens,
            "hitRate": round(hit_tokens / total, 4) if total else None,
        },
    }, outcomes


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--search-results", type=Path, required=True)
    parser.add_argument("--scripts-dir", type=Path, required=True)
    parser.add_argument("--requests", type=int, default=128)
    parser.add_argument("--concurrency", type=int, default=32)
    args = parser.parse_args()

    sys.path.insert(0, str(args.scripts_dir))
    from personamem_v2.pm_responses import pm_answer_prompt

    config = {
        **os.environ,
        **{key: value for key, value in dotenv_values(args.env).items() if value},
    }
    api_key = config.get("ANSWER_API_KEY")
    base_url = config.get("ANSWER_BASE_URL")
    model = config.get("ANSWER_MODEL")
    if not api_key or not base_url or not model:
        raise RuntimeError("ANSWER_API_KEY, ANSWER_BASE_URL, and ANSWER_MODEL are required")

    payload = json.loads(args.search_results.read_text(encoding="utf-8"))
    all_rows = [values[0] for values in payload.values()]
    stride = max(1, len(all_rows) // args.requests)
    rows = all_rows[::stride][: args.requests]
    client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=120, max_retries=0)
    arms = [
        await run_arm(
            client,
            model,
            rows,
            lambda *, context, question, options, layout=layout: pm_answer_prompt(
                layout,
                context=context,
                question=question,
                options=options,
            ),
            args.concurrency,
            layout,
        )
        for layout in ("official", "static-first")
    ]
    await client.close()
    official = arms[0][1]
    optimized = arms[1][1]
    paired = {
        "officialOnlyCorrect": sum(
            official[key]["correct"] and not optimized[key]["correct"] for key in official
        ),
        "staticFirstOnlyCorrect": sum(
            optimized[key]["correct"] and not official[key]["correct"] for key in official
        ),
        "sameChoice": sum(
            official[key]["choice"] == optimized[key]["choice"] for key in official
        ),
    }
    print(
        json.dumps(
            {"model": model, "results": [summary for summary, _outcomes in arms], "paired": paired},
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
