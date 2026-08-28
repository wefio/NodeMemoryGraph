import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const gpuPython = resolve(repoRoot, ".benchmarks", "bge-venv", "Scripts", "python.exe");
const python = existsSync(gpuPython)
  ? gpuPython
  : process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

function runPython(source: string) {
  return spawnSync(python, ["-c", source], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("embedding batcher merges concurrent requests and preserves response order", () => {
  const result = runPython(String.raw`
import asyncio
from evals.omnimemeval.embedding_batcher import EmbeddingBatcher

calls = []
def encode(texts):
    calls.append(list(texts))
    return [[float(index)] for index, _ in enumerate(texts)]

async def main():
    batcher = EmbeddingBatcher(encode, max_batch_texts=16, max_queue_requests=16, batch_wait_ms=20)
    await batcher.start()
    try:
        results = await asyncio.gather(
            batcher.embed(["a", "b"]),
            batcher.embed(["c"]),
            batcher.embed(["d", "e"]),
        )
        assert calls == [["a", "b", "c", "d", "e"]], calls
        assert results == [[[0.0], [1.0]], [[2.0]], [[3.0], [4.0]]], results
        assert batcher.stats()["batches"] == 1
    finally:
        await batcher.close()

asyncio.run(main())
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("embedding batcher rejects requests when its bounded queue is full", () => {
  const result = runPython(String.raw`
import asyncio
from evals.omnimemeval.embedding_batcher import EmbeddingBatcher, EmbeddingQueueFull

async def main():
    batcher = EmbeddingBatcher(lambda texts: texts, max_queue_requests=1)
    first = asyncio.create_task(batcher.embed(["first"]))
    await asyncio.sleep(0)
    try:
        await batcher.embed(["second"])
    except EmbeddingQueueFull:
        pass
    else:
        raise AssertionError("second request should be rejected")
    first.cancel()
    try:
        await first
    except asyncio.CancelledError:
        pass

asyncio.run(main())
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
