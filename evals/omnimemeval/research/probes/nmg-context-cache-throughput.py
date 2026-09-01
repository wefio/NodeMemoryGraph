"""Compare ordinary concurrency with NMG evidence-prefix lanes on LoCoMo.

The probe uses saved search contexts, keeps official answer prompts unchanged
apart from an arm nonce at the NMG-context boundary, and persists no answers.
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
from contextlib import asynccontextmanager
from pathlib import Path
from statistics import mean, median

from dotenv import dotenv_values
from openai import AsyncOpenAI


_MEMORY_DETAIL = re.compile(r"^\s*memory=([^;\n]+)", re.MULTILINE)


def nmg_evidence_prefix_key(context: str) -> str | None:
    match = _MEMORY_DETAIL.search(context)
    return match.group(1).strip() if match else None


class PrefixLanes:
    def __init__(self, enabled: bool):
        self.enabled = enabled
        self._locks: dict[str, asyncio.Lock] = {}

    @asynccontextmanager
    async def lane(self, key: str | None):
        if not self.enabled or key is None:
            yield
            return
        async with self._locks.setdefault(key, asyncio.Lock()):
            yield


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


async def run_arm(client, model, rows, prompt_template, concurrency, mode):
    semaphore = asyncio.Semaphore(concurrency)
    lanes = PrefixLanes(mode == "prefix-lanes")
    nonce = uuid.uuid4().hex
    latencies = []
    hit_tokens = 0
    miss_tokens = 0

    prepared = []
    for row in rows:
        normalized = re.sub(
            r"NMG evidence for \d+ selected record\(s\):",
            "NMG selected evidence:",
            str(row["context"]),
            count=1,
        )
        prepared.append((nmg_evidence_prefix_key(normalized), row, normalized))
    if mode == "staggered-order":
        buckets = {}
        for item in prepared:
            buckets.setdefault(item[0] or uuid.uuid4().hex, []).append(item)
        prepared = []
        while buckets:
            for key in list(buckets):
                prepared.append(buckets[key].pop(0))
                if not buckets[key]:
                    del buckets[key]

    async def call(prefix_key, row, normalized_context):
        nonlocal hit_tokens, miss_tokens
        context = normalized_context.replace(
            "NMG selected evidence:",
            f"[context-cache-probe={nonce}]\nNMG selected evidence:",
            1,
        )
        prompt = prompt_template.format(context=context, question=row["query"])
        async with lanes.lane(prefix_key):
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

    started = time.perf_counter()
    await asyncio.gather(*(call(*item) for item in prepared))
    elapsed = time.perf_counter() - started
    total = hit_tokens + miss_tokens
    return {
        "mode": mode,
        "requests": len(rows),
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
    }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--search-results", type=Path, required=True)
    parser.add_argument("--scripts-dir", type=Path, required=True)
    parser.add_argument("--requests", type=int, default=64)
    parser.add_argument("--concurrency", type=int, default=32)
    args = parser.parse_args()

    sys.path.insert(0, str(args.scripts_dir))
    from utils.prompts import LOCOMO_ANSWER_PROMPT

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
    rows = next(iter(payload.values()))[: args.requests]
    client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=120, max_retries=0)
    fixed_prefix = LOCOMO_ANSWER_PROMPT.split("{context}", 1)[0]
    await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": fixed_prefix}],
        temperature=0,
        max_tokens=1,
        extra_body={"thinking": {"type": "disabled"}},
    )
    results = [
        await run_arm(client, model, rows, LOCOMO_ANSWER_PROMPT, args.concurrency, mode)
        for mode in ("ordinary", "staggered-order", "prefix-lanes")
    ]
    await client.close()
    print(json.dumps({"model": model, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
