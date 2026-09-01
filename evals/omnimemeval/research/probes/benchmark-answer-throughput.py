"""Measure official DeepSeek answer throughput on disjoint benchmark prompts.

The probe is intentionally benchmark-only.  It reuses saved LongMemEval search
results, assigns length-matched disjoint prompts to each concurrency arm, and
prints timing/cache accounting without persisting model answers.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path
from statistics import mean, median

from dotenv import dotenv_values
from openai import AsyncOpenAI


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def usage_value(usage: object, name: str) -> int:
    value = getattr(usage, name, 0)
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def load_prompts(search_path: Path, scripts_dir: Path) -> list[str]:
    sys.path.insert(0, str(scripts_dir))
    from utils.prompts import LME_ANSWER_PROMPT  # pylint: disable=import-outside-toplevel

    payload = json.loads(search_path.read_text(encoding="utf-8"))
    rows = [records[0] for records in payload.values()]
    return [
        LME_ANSWER_PROMPT.format(
            question=row["question"],
            question_date=row["date"],
            context=row["search_context"],
        )
        for row in rows
    ]


def assign_length_matched_arms(
    prompts: list[str], concurrencies: list[int], per_arm: int
) -> dict[int, list[str]]:
    required = len(concurrencies) * per_arm
    if len(prompts) < required:
        raise ValueError(f"need {required} distinct prompts, found {len(prompts)}")
    selected = sorted(prompts, key=len)[:required]
    arms = {value: [] for value in concurrencies}
    for index, prompt in enumerate(selected):
        arms[concurrencies[index % len(concurrencies)]].append(prompt)
    return arms


async def run_arm(
    client: AsyncOpenAI,
    model: str,
    prompts: list[str],
    concurrency: int,
    max_tokens: int,
    warm_prefix: bool,
) -> dict[str, object]:
    semaphore = asyncio.Semaphore(concurrency)
    latencies: list[float] = []
    cache_hits = 0
    cache_misses = 0

    arm_nonce = uuid.uuid4().hex

    def with_nonce(prompt: str) -> str:
        return prompt.replace(
            "Conversation memories:",
            f"[throughput-probe={arm_nonce}]\nConversation memories:",
            1,
        )

    if warm_prefix:
        seeded = with_nonce(prompts[0]).split("Conversation memories:", 1)[0]
        await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": seeded}],
            temperature=0,
            max_tokens=1,
            extra_body={"thinking": {"type": "disabled"}},
        )

    async def call(prompt: str) -> None:
        nonlocal cache_hits, cache_misses
        # Saved prompts may still be fully resident in DeepSeek's cache from a
        # previous benchmark run.  Break the prefix exactly where dynamic
        # retrieval context begins so the probe measures reusable template
        # tokens rather than accidental full-prompt replay hits.
        prompt = with_nonce(prompt)
        async with semaphore:
            started = time.perf_counter()
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                max_tokens=max_tokens,
                extra_body={"thinking": {"type": "disabled"}},
            )
            latencies.append((time.perf_counter() - started) * 1000)
            cache_hits += usage_value(response.usage, "prompt_cache_hit_tokens")
            cache_misses += usage_value(response.usage, "prompt_cache_miss_tokens")

    started = time.perf_counter()
    await asyncio.gather(*(call(prompt) for prompt in prompts))
    elapsed = time.perf_counter() - started
    cache_total = cache_hits + cache_misses
    return {
        "concurrency": concurrency,
        "warmPrefix": warm_prefix,
        "requests": len(prompts),
        "wallSeconds": round(elapsed, 3),
        "requestsPerSecond": round(len(prompts) / elapsed, 3),
        "latencyMs": {
            "mean": round(mean(latencies), 1),
            "p50": round(median(latencies), 1),
            "p95": round(percentile(latencies, 0.95), 1),
        },
        "cache": {
            "hitTokens": cache_hits,
            "missTokens": cache_misses,
            "hitRate": round(cache_hits / cache_total, 4) if cache_total else None,
        },
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--search-results", type=Path, required=True)
    parser.add_argument("--scripts-dir", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, nargs="+", default=[16, 32])
    parser.add_argument("--per-arm", type=int, default=32)
    parser.add_argument("--max-tokens", type=int, default=32)
    parser.add_argument("--warm-prefix", action="store_true")
    args = parser.parse_args()

    config = {**os.environ, **{key: value for key, value in dotenv_values(args.env).items() if value}}
    api_key = config.get("ANSWER_API_KEY")
    base_url = config.get("ANSWER_BASE_URL")
    model = config.get("ANSWER_MODEL")
    if not api_key or not base_url or not model:
        raise RuntimeError("ANSWER_API_KEY, ANSWER_BASE_URL, and ANSWER_MODEL are required")

    prompts = load_prompts(args.search_results, args.scripts_dir)
    arms = assign_length_matched_arms(prompts, args.concurrency, args.per_arm)
    client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=120, max_retries=0)
    results = []
    for concurrency in args.concurrency:
        results.append(
            await run_arm(
                client,
                model,
                arms[concurrency],
                concurrency,
                args.max_tokens,
                args.warm_prefix,
            )
        )
    await client.close()
    print(json.dumps({"model": model, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
