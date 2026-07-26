# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "sentence-transformers",
# ]
# ///
"""Small local OpenAI-compatible embedding server for benchmark ablations.

The model must already exist in the Hugging Face cache. This helper deliberately
does not download models or implement a production serving stack.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from sentence_transformers import SentenceTransformer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    model = SentenceTransformer(args.model, local_files_only=True)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path not in {"/embeddings", "/v1/embeddings"}:
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(length))
                inputs = payload.get("input")
                if isinstance(inputs, str):
                    inputs = [inputs]
                if not isinstance(inputs, list) or not all(
                    isinstance(item, str) for item in inputs
                ):
                    raise ValueError("input must be a string or a list of strings")
                vectors = model.encode(
                    inputs,
                    batch_size=min(64, max(1, len(inputs))),
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                self._json(
                    200,
                    {
                        "object": "list",
                        "model": payload.get("model", args.model),
                        "data": [
                            {
                                "object": "embedding",
                                "index": index,
                                "embedding": vector.tolist(),
                            }
                            for index, vector in enumerate(vectors)
                        ],
                    },
                )
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self._json(400, {"error": {"message": str(error)}})

        def log_message(self, format: str, *args: Any) -> None:
            del format, args

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        json.dumps(
            {
                "status": "ready",
                "model": args.model,
                "dimensions": model.get_sentence_embedding_dimension(),
                "url": f"http://{args.host}:{args.port}/v1",
            }
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
