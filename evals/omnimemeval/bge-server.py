"""Minimal OpenAI-compatible BGE embedding server (uv-run target).

Serves BAAI/bge-small-en-v1.5 on http://127.0.0.1:8000 so the NMG eval
bridge can embed through the standard OpenAI client. Routes:
  POST /embeddings        (NMG_EMBED_BASE_URL without /v1)
  POST /v1/embeddings     (conventional OpenAI path)

Start:  uv run --with sentence-transformers --with fastapi --with "uvicorn[standard]" python bge-server.py
"""
from __future__ import annotations

import os
import sys

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import uvicorn

MODEL_NAME = os.environ.get("BGE_MODEL", "BAAI/bge-small-en-v1.5")
PORT = int(os.environ.get("BGE_PORT", "8000"))

# Prefer CUDA when available (sentence-transformers defaults to CPU).
import torch
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[bge-server] device={DEVICE}", flush=True)
model = SentenceTransformer(MODEL_NAME, device=DEVICE)
app = FastAPI(title="bge-embed")


class EmbedRequest(BaseModel):
    input: str | list[str]
    model: str | None = None


@app.post("/embeddings")
@app.post("/v1/embeddings")
def embed(req: EmbedRequest) -> dict:
    texts = [req.input] if isinstance(req.input, str) else req.input
    vectors = model.encode(texts, normalize_embeddings=True)
    return {
        "object": "list",
        "model": req.model or MODEL_NAME,
        "data": [
            {"object": "embedding", "embedding": v.tolist(), "index": i}
            for i, v in enumerate(vectors)
        ],
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
