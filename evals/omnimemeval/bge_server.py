"""Single local OpenAI-compatible BGE embedding service entrypoint.

When ``--device`` is omitted, CUDA is used when the current Python environment
can see it and CPU is used otherwise. Pass ``--device cpu`` or
``--device cuda`` to force a device; explicit CUDA never silently falls back.
"""

from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
from dataclasses import dataclass
import os
import sys
from typing import Any

if __package__:
    from .embedding_batcher import EmbeddingBatcher, EmbeddingQueueFull
else:
    from embedding_batcher import EmbeddingBatcher, EmbeddingQueueFull


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    model: str
    requested_device: str | None
    max_batch_texts: int
    max_queue_requests: int
    batch_wait_ms: float
    encode_batch_size: int


def select_device(requested: str | None, cuda_available: bool) -> str:
    """Resolve an omitted, CPU, or CUDA device request without hidden fallback."""
    if requested is None:
        return "cuda" if cuda_available else "cpu"
    if requested == "cpu":
        return "cpu"
    if requested == "cuda":
        if not cuda_available:
            raise RuntimeError(
                "--device cuda was requested, but CUDA is unavailable in this Python environment"
            )
        return "cuda"
    raise ValueError("device must be cpu or cuda")


def parse_args(argv: list[str] | None = None) -> ServerConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("BGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BGE_PORT", "8000")))
    parser.add_argument(
        "--model",
        default=os.environ.get("BGE_MODEL", "BAAI/bge-small-en-v1.5"),
    )
    parser.add_argument(
        "--device",
        choices=("cpu", "cuda"),
        default=os.environ.get("BGE_DEVICE") or None,
        help="force cpu or cuda; omit to select CUDA when available",
    )
    parser.add_argument(
        "--max-batch-texts",
        type=int,
        default=int(os.environ.get("BGE_MAX_BATCH_TEXTS", "256")),
    )
    parser.add_argument(
        "--max-queue-requests",
        type=int,
        default=int(os.environ.get("BGE_MAX_QUEUE_REQUESTS", "256")),
    )
    parser.add_argument(
        "--batch-wait-ms",
        type=float,
        default=float(os.environ.get("BGE_BATCH_WAIT_MS", "5")),
    )
    parser.add_argument(
        "--encode-batch-size",
        type=int,
        default=int(os.environ.get("BGE_ENCODE_BATCH_SIZE", "64")),
    )
    args = parser.parse_args(argv)
    if (
        args.port < 1
        or args.max_batch_texts < 1
        or args.max_queue_requests < 1
        or args.encode_batch_size < 1
        or args.batch_wait_ms < 0
    ):
        parser.error("port and batch limits must be positive; batch wait must be non-negative")
    return ServerConfig(
        host=args.host,
        port=args.port,
        model=args.model,
        requested_device=args.device,
        max_batch_texts=args.max_batch_texts,
        max_queue_requests=args.max_queue_requests,
        batch_wait_ms=args.batch_wait_ms,
        encode_batch_size=args.encode_batch_size,
    )


def create_app(config: ServerConfig) -> Any:
    import torch
    from fastapi import FastAPI, HTTPException
    from sentence_transformers import SentenceTransformer

    device = select_device(config.requested_device, torch.cuda.is_available())
    print(
        f"[bge-server] python={sys.executable} torch={torch.__version__} "
        f"device={device} model={config.model}",
        flush=True,
    )
    model = SentenceTransformer(config.model, device=device)

    def encode_batch(texts: list[str]):
        return model.encode(
            texts,
            batch_size=config.encode_batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
        )

    batcher = EmbeddingBatcher(
        encode_batch,
        max_batch_texts=config.max_batch_texts,
        max_queue_requests=config.max_queue_requests,
        batch_wait_ms=config.batch_wait_ms,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await batcher.start()
        try:
            yield
        finally:
            await batcher.close()

    app = FastAPI(title="bge-embed", lifespan=lifespan)

    @app.post("/embeddings")
    @app.post("/v1/embeddings")
    async def embed(payload: dict[str, Any]) -> dict[str, Any]:
        inputs = payload.get("input")
        texts = [inputs] if isinstance(inputs, str) else inputs
        if not isinstance(texts, list) or not texts or not all(
            isinstance(text, str) and text for text in texts
        ):
            raise HTTPException(status_code=400, detail="input must contain non-empty strings")
        try:
            vectors = await batcher.embed(texts)
        except EmbeddingQueueFull as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {
            "object": "list",
            "model": payload.get("model") or config.model,
            "data": [
                {"object": "embedding", "embedding": vector.tolist(), "index": index}
                for index, vector in enumerate(vectors)
            ],
        }

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "model": config.model,
            "device": device,
            "python": sys.executable,
            "torch": torch.__version__,
            "batcher": batcher.stats(),
        }

    return app


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    config = parse_args(argv)
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="warning")


if __name__ == "__main__":
    main()
