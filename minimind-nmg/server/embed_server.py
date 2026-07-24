"""Simple ONNX inference server (OpenAI-compatible /embeddings endpoint)."""

import json
import sys
import argparse
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import onnxruntime as ort
from transformers import AutoTokenizer


class EmbeddingServer(BaseHTTPRequestHandler):
    session: ort.InferenceSession
    tokenizer: AutoTokenizer
    lookup: np.ndarray  # old_id → new_id, fallback=0
    max_length: int = 128

    def do_POST(self):
        if self.path not in ("/embeddings", "/v1/embeddings"):
            self.send_error(404)
            return

        try:
            body_len = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(body_len))
            inputs = body.get("input", body.get("inputs", []))
            if isinstance(inputs, str):
                inputs = [inputs]
        except Exception:
            self.send_error(400, "Bad JSON")
            return

        try:
            embeddings = self._embed(inputs)
        except Exception as e:
            self.send_error(500, str(e))
            return

        resp = {
            "object": "list",
            "data": [{"object": "embedding", "index": i, "embedding": emb.tolist()}
                     for i, emb in enumerate(embeddings)],
            "model": "minimind-nmg-encoder",
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        }

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(resp, ensure_ascii=False).encode())

    def _embed(self, texts: list[str]) -> list[np.ndarray]:
        encoded = self.tokenizer(
            texts, padding="max_length", truncation=True,
            max_length=self.max_length, return_tensors="np",
        )
        ids_raw = encoded["input_ids"]
        ids = self.lookup[np.clip(ids_raw, 0, len(self.lookup) - 1)].astype(np.int64)
        mask = encoded["attention_mask"].astype(np.int64)

        emb, _ = self.session.run(None, {
            "input_ids": ids,
            "attention_mask": mask,
        })
        return [emb[i] for i in range(emb.shape[0])]

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {args[0]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="./out/onnx/encoder.onnx")
    parser.add_argument("--tokenizer", default="./qwen3-embedding")
    parser.add_argument("--mapping", default="./out/tokenizer/old_to_new.json")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--max_length", type=int, default=128)
    args = parser.parse_args()

    print(f"Loading ONNX model: {args.model}")
    session = ort.InferenceSession(
        args.model,
        providers=["CPUExecutionProvider"],  # Use CPU for simplicity; switch to CUDA if needed
    )

    print(f"Loading tokenizer: {args.tokenizer}")
    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer)

    print(f"Loading vocab mapping: {args.mapping}")
    with open(args.mapping) as f:
        old_to_new = {int(k): v for k, v in json.load(f).items()}
    max_old = max(old_to_new.keys())
    lookup = np.full(max_old + 1, 0, dtype=np.int64)
    for old, new in old_to_new.items():
        lookup[old] = new

    EmbeddingServer.session = session
    EmbeddingServer.tokenizer = tokenizer
    EmbeddingServer.lookup = lookup
    EmbeddingServer.max_length = args.max_length

    server = HTTPServer(("127.0.0.1", args.port), EmbeddingServer)
    print(f"Listening on http://127.0.0.1:{args.port}/embeddings")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
