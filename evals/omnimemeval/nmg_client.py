"""OmniMemEval user-memory adapter for Node Memory Graph.

Use ``install-adapter.ts`` to install the client and shared temporal policy in
OmniMemEval's ``scripts/client_factory`` and register ``nmg``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from functools import lru_cache
from http.client import HTTPException
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


@lru_cache(maxsize=1)
def _temporal_policy() -> dict[str, re.Pattern[str]]:
    # The installer copies the product-owned policy beside the adapter. Source
    # execution reads that same owner, not a second benchmark-only vocabulary.
    directory = Path(__file__).resolve().parent
    path = directory / "nmg_temporal_evidence_policy.json"
    if not path.is_file():
        path = directory.parent.parent / "src/integration/temporal-evidence-policy.json"
    policy = json.loads(path.read_text(encoding="utf-8"))
    return {key: re.compile("|".join(value) if isinstance(value, list) else value,
                            re.ASCII | (0 if key == "isoTime" else re.IGNORECASE))
            for key, value in policy.items()}


def _render_remote_evidence(item: dict[str, Any], query: str) -> str:
    content = item["content"]
    # Legacy NMG AML responses used created_at as a historical-time alias.
    # An explicit null event_time is unknown, not permission to use write time.
    event_time = item.get("event_time") if "event_time" in item else item.get("created_at")
    if not isinstance(event_time, str):
        return content
    policy = _temporal_policy()
    if policy["timestampPrefix"].search(content) or not policy["isoTime"].fullmatch(event_time):
        return content
    try:
        datetime.fromisoformat(event_time.replace("Z", "+00:00"))
    except ValueError:
        return content
    if not policy["temporalQuery"].search(query) and not policy["relativeEvidence"].search(content):
        return content
    return f"[Timestamp: {event_time}] {content}"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise URLError("NMG HTTP transport refuses redirects")


class NmgRemoteError(RuntimeError):
    """A remote failure with bounded, credential-redacted diagnostic evidence."""

    def __init__(self, message: str, diagnostic: dict[str, Any]) -> None:
        self.diagnostic = diagnostic
        super().__init__(message + "; diagnostic=" + json.dumps(diagnostic, ensure_ascii=True))


class NmgClient:
    """Delegate memory behaviour to the local bridge or deployed AML API."""

    def __init__(self) -> None:
        self._process: subprocess.Popen[str] | None = None
        self._remote_url = os.environ.get("NMG_OMNI_API_URL", "").rstrip("/")
        self._remote_token = os.environ.get("NMG_OMNI_API_TOKEN", "")
        self._remote_namespace = os.environ.get("NMG_OMNI_API_NAMESPACE", "").strip()
        if self._remote_url:
            self._validate_remote_configuration()
            return
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
        if self._remote_url:
            raise RuntimeError("AML Add receipts do not expose materialized memory records")
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

    def _validate_remote_configuration(self) -> None:
        url = urlsplit(self._remote_url)
        if url.scheme not in {"http", "https"} or not url.hostname:
            raise ValueError("NMG_OMNI_API_URL must be an absolute HTTP(S) URL")
        if url.username or url.password or url.query or url.fragment:
            raise ValueError("NMG_OMNI_API_URL must not contain credentials, query, or fragment")
        if url.scheme != "https" and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("NMG_OMNI_API_URL requires HTTPS except for local tests")
        if not self._remote_token:
            raise ValueError("NMG_OMNI_API_TOKEN is required for HTTP mode")
        if not self._remote_namespace:
            raise ValueError("NMG_OMNI_API_NAMESPACE is required for isolated HTTP runs")

    def _post_remote(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        request = Request(
            self._remote_url + path,
            data=body,
            headers={
                "Authorization": "Bearer " + self._remote_token,
                "Content-Type": "application/json",
                "User-Agent": "NodeMemoryGraph-OmniMemEval/0.1",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with build_opener(_NoRedirect()).open(request, timeout=180) as response:
                if response.status != 200:
                    raise RuntimeError(f"NMG {path} requires synchronous HTTP 200, got {response.status}")
                result = json.loads(response.read())
        except HTTPError as error:
            raise self._remote_failure(path, payload, started, error) from None
        except (URLError, TimeoutError, ConnectionError, HTTPException) as error:
            raise self._remote_failure(path, payload, started, error) from None
        if not isinstance(result, dict):
            raise RuntimeError(f"NMG {path} response must be a JSON object")
        return result

    def _remote_failure(
        self, path: str, payload: dict[str, Any], started: float, error: BaseException
    ) -> NmgRemoteError:
        diagnostic: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "path": path,
            "exception_type": type(error).__name__,
            "request_id": payload.get("request_id"),
            "user_id": payload.get("user_id"),
            "session_id": payload.get("session_id"),
            "http_status": None,
            "error_code": None,
            "response_body": None,
            "response_headers": {},
            "body_truncated": False,
        }
        message = f"NMG {path} transport failed: {type(error).__name__}"
        if isinstance(error, HTTPError):
            message = f"NMG {path} failed with HTTP {error.code}"
            diagnostic["http_status"] = error.code
            headers = error.headers or {}
            for key in ("Content-Type", "Retry-After", "CF-Ray", "Server", "Date", "X-Request-Id", "X-Correlation-Id", "Traceparent"):
                value = headers.get(key)
                if value is not None:
                    diagnostic["response_headers"][key.lower()] = value
            try:
                with error:
                    raw = error.read(16385)
                diagnostic["body_truncated"] = len(raw) > 16384
                text = raw[:16384].decode("utf-8", errors="replace")
                try:
                    diagnostic["response_body"] = json.loads(text)
                    diagnostic["response_format"] = "json"
                except ValueError:
                    diagnostic["response_body"] = text
                    diagnostic["response_format"] = "text"
            except (OSError, HTTPException, ValueError) as read_error:
                diagnostic["body_read_error"] = type(read_error).__name__
            response_body = diagnostic["response_body"]
            if isinstance(response_body, dict) and isinstance(response_body.get("error"), dict):
                diagnostic["error_code"] = response_body["error"].get("code")
        diagnostic["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 3)
        # The body can echo credentials; sanitize every captured field, not only
        # headers. Request messages/query and non-allowlisted headers are omitted.
        redacted = json.dumps(diagnostic, ensure_ascii=True).replace(self._remote_token, "<REDACTED>")
        return NmgRemoteError(message, json.loads(redacted))

    def _request_remote(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        user_id = self._remote_namespace + ":" + payload["userId"]
        if operation == "add":
            body = {
                "user_id": user_id,
                "session_id": payload.get("conversationId") or "default",
                "messages": payload["messages"],
            }
            digest = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
            body["request_id"] = "omni:" + digest
            result = self._post_remote("/add", body)
            if result.get("success") is not True or any(
                result.get(key) != body[key] for key in ("request_id", "user_id", "session_id")
            ):
                raise RuntimeError("NMG Add success/echo contract mismatch")
            return result
        if operation == "search":
            return self._search_remote(payload["query"], user_id, payload["topK"])
        raise RuntimeError(f"HTTP mode does not support {operation}; remote deletion is disabled")

    def _search_remote(self, query: str, user_id: str, top_k: int) -> dict[str, Any]:
        result = self._post_remote("/search", {
            "query": query, "user_id": user_id, "top_k": top_k,
        })
        data = result.get("data")
        if not isinstance(data, list) or len(data) > top_k:
            raise RuntimeError("NMG Search requires data[] with at most top_k memories")
        for item in data:
            if not isinstance(item, dict) or not item.get("id"):
                raise RuntimeError("NMG Search memory requires a stable id")
            content = item.get("content")
            if not isinstance(content, str) or not content.strip():
                raise RuntimeError("NMG Search requires non-empty textual memory content")
        return {"text": "\n\n".join(_render_remote_evidence(item, query) for item in data), "candidates": data}

    def _request(self, operation: str, **payload: Any) -> dict[str, Any]:
        if self._remote_url:
            return self._request_remote(operation, payload)
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
