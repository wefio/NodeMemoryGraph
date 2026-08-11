"""OmniMemEval user-memory adapter for Node Memory Graph.

Copy or symlink this file into OmniMemEval's ``scripts/client_factory`` and add
``"nmg": ("nmg_client", "NmgClient")`` to its registry.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any


class NmgClient:
    """Thin adapter that delegates all memory behaviour to the NMG bridge."""

    def __init__(self) -> None:
        root = Path(os.environ.get("NMG_ROOT", Path.cwd())).resolve()
        bridge = root / "evals" / "omnimemeval" / "bridge.ts"
        if not bridge.is_file():
            raise FileNotFoundError(
                f"NMG bridge not found at {bridge}; set NMG_ROOT to the NMG checkout"
            )
        env = os.environ.copy()
        env.setdefault(
            "NMG_OMNI_DATA_DIR",
            str(root / ".benchmarks" / "omnimemeval-nmg"),
        )
        self._process = subprocess.Popen(
            [
                os.environ.get("NMG_NODE", "node"),
                "--experimental-strip-types",
                str(bridge),
            ],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._lock = threading.Lock()
        self._next_id = 0

    def add(
        self,
        messages: list[dict[str, Any]],
        user_id: str,
        conv_id: str | None = None,
        batch_size: int | None = None,
    ) -> None:
        del batch_size  # OmniMemEval owns replay batching.
        self._request(
            "add",
            userId=user_id,
            messages=messages,
            conversationId=conv_id,
        )

    def add_with_result(
        self,
        messages: list[dict[str, Any]],
        user_id: str,
        conv_id: str | None = None,
        batch_size: int | None = None,
    ) -> dict[str, Any]:
        """Add one conversation and return the memories actually materialized.

        This is used by operation-level memory benchmarks.  The ordinary
        OmniMemEval ``add`` contract intentionally remains write-only.
        """
        del batch_size
        return self._request(
            "add",
            userId=user_id,
            messages=messages,
            conversationId=conv_id,
        )

    def search(self, query: str, user_id: str, top_k: int) -> str:
        result = self._request(
            "search",
            userId=user_id,
            query=query,
            topK=top_k,
        )
        return str(result.get("text", ""))

    def search_with_result(
        self, query: str, user_id: str, top_k: int
    ) -> dict[str, Any]:
        """Return structured candidates for update evaluation."""
        return self._request(
            "search",
            userId=user_id,
            query=query,
            topK=top_k,
        )

    def delete(self, user_id: str) -> None:
        self._request("delete", userId=user_id)

    def delete_all(self, user_id: str) -> None:
        self.delete(user_id)

    def close(self) -> None:
        process = getattr(self, "_process", None)
        if process is None:
            return
        if process.poll() is None:
            try:
                self._request("close")
            except (RuntimeError, BrokenPipeError):
                pass
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        self._process = None

    def _request(self, operation: str, **payload: Any) -> dict[str, Any]:
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                raise RuntimeError("NMG bridge is not running")
            assert process.stdin is not None
            assert process.stdout is not None
            self._next_id += 1
            request_id = self._next_id
            # Keep the line protocol ASCII-only.  OmniMemEval conversations can
            # contain arbitrary Unicode (including malformed surrogate data in
            # upstream corpora); JSON escapes preserve the content while making
            # the Python-to-Node pipe portable on Windows.
            process.stdin.write(
                json.dumps(
                    {"id": request_id, "op": operation, **payload},
                    ensure_ascii=True,
                )
                + "\n"
            )
            process.stdin.flush()
            line = process.stdout.readline()
            if not line:
                raise RuntimeError("NMG bridge closed without a response")
            response = json.loads(line)
            if response.get("id") != request_id:
                raise RuntimeError(
                    "NMG bridge response id mismatch: "
                    f"expected {request_id!r}, got {response.get('id')!r}; "
                    f"bridge error: {response.get('error')!r}"
                )
            if response.get("error"):
                raise RuntimeError(str(response["error"]))
            result = response.get("result")
            return result if isinstance(result, dict) else {}

    def __enter__(self) -> "NmgClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
