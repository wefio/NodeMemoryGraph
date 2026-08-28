"""Bounded cross-request batching for the local embedding evaluation server."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Callable, Sequence


class EmbeddingQueueFull(RuntimeError):
    """Raised when the server cannot admit another embedding request."""


@dataclass
class _PendingRequest:
    texts: list[str]
    future: asyncio.Future[list[Any]]


class EmbeddingBatcher:
    """Merge concurrent requests into one bounded model invocation."""

    def __init__(
        self,
        encode: Callable[[list[str]], Sequence[Any]],
        *,
        max_batch_texts: int = 256,
        max_queue_requests: int = 256,
        batch_wait_ms: float = 5,
    ) -> None:
        if max_batch_texts < 1 or max_queue_requests < 1 or batch_wait_ms < 0:
            raise ValueError("batch and queue limits must be positive")
        self._encode = encode
        self.max_batch_texts = max_batch_texts
        self.max_queue_requests = max_queue_requests
        self.batch_wait_ms = batch_wait_ms
        self._queue: asyncio.Queue[_PendingRequest] = asyncio.Queue(max_queue_requests)
        self._worker: asyncio.Task[None] | None = None
        self._carry: _PendingRequest | None = None
        self._batches = 0
        self._requests = 0
        self._texts = 0

    async def start(self) -> None:
        if self._worker is None:
            self._worker = asyncio.create_task(self._run(), name="embedding-batcher")

    async def close(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            with suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None
        error = RuntimeError("embedding batcher stopped")
        pending = [self._carry] if self._carry is not None else []
        self._carry = None
        while not self._queue.empty():
            pending.append(self._queue.get_nowait())
        for request in pending:
            if request is not None and not request.future.done():
                request.future.set_exception(error)

    async def embed(self, texts: list[str]) -> list[Any]:
        if not texts:
            raise ValueError("input must contain at least one string")
        if len(texts) > self.max_batch_texts:
            raise ValueError(f"one request may contain at most {self.max_batch_texts} strings")
        future = asyncio.get_running_loop().create_future()
        try:
            self._queue.put_nowait(_PendingRequest(list(texts), future))
        except asyncio.QueueFull as error:
            raise EmbeddingQueueFull("embedding request queue is full") from error
        return await future

    def stats(self) -> dict[str, int | float]:
        return {
            "queuedRequests": self._queue.qsize() + (1 if self._carry is not None else 0),
            "maxQueueRequests": self.max_queue_requests,
            "maxBatchTexts": self.max_batch_texts,
            "batchWaitMs": self.batch_wait_ms,
            "batches": self._batches,
            "requests": self._requests,
            "texts": self._texts,
        }

    async def _run(self) -> None:
        while True:
            requests = await self._collect_batch()
            texts = [text for request in requests for text in request.texts]
            try:
                vectors = list(await asyncio.to_thread(self._encode, texts))
                if len(vectors) != len(texts):
                    raise RuntimeError("embedding model returned the wrong vector count")
                offset = 0
                for request in requests:
                    next_offset = offset + len(request.texts)
                    if not request.future.done():
                        request.future.set_result(vectors[offset:next_offset])
                    offset = next_offset
                self._batches += 1
                self._requests += len(requests)
                self._texts += len(texts)
            except Exception as error:
                for request in requests:
                    if not request.future.done():
                        request.future.set_exception(error)

    async def _collect_batch(self) -> list[_PendingRequest]:
        first = self._carry or await self._queue.get()
        self._carry = None
        requests = [first]
        text_count = len(first.texts)
        deadline = asyncio.get_running_loop().time() + self.batch_wait_ms / 1000

        while text_count < self.max_batch_texts:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                candidate = await asyncio.wait_for(self._queue.get(), timeout=remaining)
            except TimeoutError:
                break
            if text_count + len(candidate.texts) > self.max_batch_texts:
                self._carry = candidate
                break
            requests.append(candidate)
            text_count += len(candidate.texts)
        return requests
