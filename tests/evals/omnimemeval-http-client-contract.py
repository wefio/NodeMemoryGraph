"""Contract and safety checks for the shared OmniMemEval HTTP transport."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import tempfile
import threading
import unittest
from email.message import Message
from http.client import RemoteDisconnected
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "nmg_client", ROOT / "evals" / "omnimemeval" / "nmg_client.py"
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HttpTransportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.requests: list[dict] = []
        self.response_override: dict | None = None
        self.response_status = 200
        self.raw_response: bytes | None = None
        self.content_type = "application/json"
        self.response_headers: dict[str, str] = {}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append(
                    {"path": self.path, "body": body, "auth": self.headers.get("Authorization"),
                     "user_agent": self.headers.get("User-Agent")}
                )
                if self.path == "/add":
                    response = {"success": True, **{key: body[key] for key in (
                        "request_id", "user_id", "session_id"
                    )}}
                else:
                    response = {"data": [{"id": "m1", "content": "remembered evidence"}]}
                if owner.response_override is not None:
                    response = owner.response_override
                data = owner.raw_response if owner.raw_response is not None else json.dumps(response).encode("utf-8")
                self.send_response(owner.response_status)
                self.send_header("Content-Type", owner.content_type)
                self.send_header("Content-Length", str(len(data)))
                for key, value in owner.response_headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.env = patch.dict(os.environ, {
            "NMG_OMNI_API_URL": f"http://127.0.0.1:{self.server.server_port}",
            "NMG_OMNI_API_TOKEN": "test-only-token",
            "NMG_OMNI_API_NAMESPACE": "omni-contract",
        })
        self.env.start()
        self.process_guard = patch("subprocess.Popen", side_effect=AssertionError(
            "HTTP mode must not launch the local bridge"
        ))
        self.process_guard.start()
        self.client = MODULE.NmgClient()

    def tearDown(self) -> None:
        if hasattr(self, "client"):
            self.client.close()
        self.process_guard.stop()
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_add_is_scoped_authenticated_and_has_stable_request_ids(self) -> None:
        messages = [{"role": "user", "content": "Unicode 记忆"}]
        self.client.add(messages, "user-1", "session-1")
        self.client.add(messages, "user-1", "session-1")
        first, second = self.requests
        self.assertEqual(first["path"], "/add")
        self.assertEqual(first["auth"], "Bearer test-only-token")
        self.assertEqual(first["user_agent"], "NodeMemoryGraph-OmniMemEval/0.1")
        self.assertEqual(first["body"]["user_id"], "omni-contract:user-1")
        self.assertEqual(first["body"]["session_id"], "session-1")
        self.assertEqual(first["body"]["messages"], messages)
        self.assertEqual(first["body"]["request_id"], second["body"]["request_id"])

    def test_search_preserves_order_budget_and_empty_results(self) -> None:
        self.assertEqual(self.client.search("query", "user-1", 20), "remembered evidence")
        self.assertEqual(self.requests[0]["body"], {
            "query": "query", "user_id": "omni-contract:user-1", "top_k": 20
        })
        self.response_override = {"data": []}
        self.assertEqual(self.client.search("none", "user-1", 20), "")

    def test_installed_adapter_uses_its_product_policy_without_a_checkout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="nmg-installed-client-") as directory:
            target = Path(directory) / "nmg_client.py"
            shutil.copyfile(ROOT / "evals/omnimemeval/nmg_client.py", target)
            shutil.copyfile(ROOT / "src/integration/temporal-evidence-policy.json",
                            target.with_name("nmg_temporal_evidence_policy.json"))
            spec = importlib.util.spec_from_file_location("installed_nmg_client", target)
            assert spec is not None and spec.loader is not None
            installed = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(installed)
            row = {"id": "m1", "content": "I visited yesterday.", "event_time": "2023-01-20"}
            self.assertEqual(installed._render_remote_evidence(row, "Which museum?"),
                             "[Timestamp: 2023-01-20] I visited yesterday.")

    def test_shared_temporal_rendering_fixtures(self) -> None:
        fixtures = json.loads((ROOT / "tests/fixtures/temporal-context.json").read_text(encoding="utf-8"))
        for item in fixtures:
            with self.subTest(query=item["query"], content=item["content"]):
                self.response_override = {"data": [{
                    "id": "m1", "content": item["content"], "event_time": item["time"],
                    "stored_at": "2026-10-22T00:00:00Z",
                }]}
                expected = f"[Timestamp: {item['time']}] {item['content']}" if item["dated"] else item["content"]
                self.assertEqual(self.client.search(item["query"], "user-1", 20), expected)

    def test_legacy_aml_timestamp_and_unknown_event_time_are_distinct(self) -> None:
        row: dict[str, str | None] = {"id": "m1", "content": "I visited yesterday.", "created_at": "2023-01-20"}
        self.response_override = {"data": [row]}
        self.assertEqual(self.client.search("Which museum?", "u", 20),
                         "[Timestamp: 2023-01-20] I visited yesterday.")
        row["event_time"] = None
        self.assertEqual(self.client.search("When?", "u", 20), row["content"])

    def test_rendering_keeps_raw_candidates_and_order(self) -> None:
        rows = [
            {"id": "first", "content": "I visited yesterday.", "event_time": "2023-01-20"},
            {"id": "second", "content": "The clinic is called Cedar.", "event_time": "2023-01-21"},
        ]
        self.response_override = {"data": rows}
        result = self.client.search_with_result("Which museum?", "u", 2)
        self.assertEqual(result["candidates"], rows)
        self.assertEqual(result["text"], "[Timestamp: 2023-01-20] I visited yesterday.\n\nThe clinic is called Cedar.")

    def test_server_rendering_is_not_duplicated_and_message_times_survive_add(self) -> None:
        content = "[Timestamp: 2023-01-20] I visited yesterday."
        self.response_override = {"data": [{"id": "m1", "content": content, "event_time": "2023-01-20"}]}
        self.assertEqual(self.client.search("When?", "u", 20), content)
        self.response_override = None
        messages = [
            {"role": "user", "content": "I visited yesterday.", "chat_time": "2023-01-20T16:04:00Z"},
            {"role": "user", "content": "The museum is called Cedar.", "timestamp": 1674230640000},
        ]
        self.client.add(messages, "u", "s")
        self.assertEqual(self.requests[-1]["body"]["messages"], messages)

    def test_bad_add_echo_is_not_counted_as_ingestion(self) -> None:
        self.response_override = {"success": True, "request_id": "wrong"}
        with self.assertRaisesRegex(RuntimeError, "echo"):
            self.client.add([{"role": "user", "content": "fact"}], "user-1", "session-1")

    def test_invalid_or_oversized_search_is_not_silently_accepted(self) -> None:
        for response in ({}, {"data": [{"id": "m1", "content": ""}]}, {
            "data": [{"id": str(i), "content": "fact"} for i in range(2)]
        }):
            self.response_override = response
            with self.assertRaises(RuntimeError):
                self.client.search("query", "user-1", 1)

    def test_destructive_and_operation_level_apis_are_explicitly_unsupported(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "delet"):
            self.client.delete("user-1")
        with self.assertRaisesRegex(RuntimeError, "materialized"):
            self.client.add_with_result([{"role": "user", "content": "fact"}], "user-1")
        self.assertEqual(self.requests, [])

    def failure_diagnostic(self) -> tuple[dict, str]:
        with self.assertRaises(RuntimeError) as caught:
            self.client.add([{"role": "user", "content": "private input"}], "user-1", "session-1")
        diagnostic = getattr(caught.exception, "diagnostic", None)
        self.assertIsInstance(diagnostic, dict, "failure must retain structured response evidence")
        assert isinstance(diagnostic, dict)
        return diagnostic, str(caught.exception)

    def test_http_error_retains_json_code_headers_and_request_correlation(self) -> None:
        self.response_status = 503
        self.response_override = {"error": {"code": "fixture_conflict", "message": "busy"}}
        self.response_headers = {"CF-Ray": "fixture-ray", "Retry-After": "2", "Set-Cookie": "private-cookie"}
        evidence, message = self.failure_diagnostic()
        self.assertEqual(evidence["http_status"], 503)
        self.assertEqual(evidence["error_code"], "fixture_conflict")
        self.assertEqual(evidence["response_body"], self.response_override)
        self.assertEqual(evidence["response_headers"]["cf-ray"], "fixture-ray")
        self.assertEqual(evidence["response_headers"]["retry-after"], "2")
        self.assertNotIn("set-cookie", evidence["response_headers"])
        for key in ("request_id", "user_id", "session_id"):
            self.assertEqual(evidence[key], self.requests[0]["body"][key])
        self.assertGreaterEqual(evidence["elapsed_ms"], 0)
        self.assertIn("timestamp", evidence)
        self.assertIn("fixture_conflict", message)
        self.assertNotIn("private input", message)
        self.assertEqual(len(self.requests), 1, "diagnostic capture must not add retries")

    def test_html_error_is_retained_without_inventing_json_code(self) -> None:
        self.response_status = 503
        self.content_type = "text/html"
        self.raw_response = b"<html>fixture proxy error</html>"
        evidence, _ = self.failure_diagnostic()
        self.assertEqual(evidence["response_body"], self.raw_response.decode())
        self.assertEqual(evidence["response_format"], "text")
        self.assertIsNone(evidence["error_code"])

    def test_diagnostic_redacts_token_and_bounds_response_body(self) -> None:
        self.response_status = 503
        self.response_override = {"error": {"code": "fixture_error", "message": "echo test-only-token"}}
        evidence, message = self.failure_diagnostic()
        self.assertNotIn("test-only-token", message)
        self.assertIn("<REDACTED>", evidence["response_body"]["error"]["message"])
        self.raw_response = b"x" * 20000
        evidence, _ = self.failure_diagnostic()
        self.assertTrue(evidence["body_truncated"])
        self.assertLessEqual(len(evidence["response_body"]), 16384)

    def test_disconnection_retains_context_without_fabricating_http_response(self) -> None:
        with patch.object(MODULE, "build_opener") as opener:
            opener.return_value.open.side_effect = RemoteDisconnected("fixture disconnect")
            evidence, message = self.failure_diagnostic()
        self.assertEqual(evidence["exception_type"], "RemoteDisconnected")
        self.assertEqual(evidence["user_id"], "omni-contract:user-1")
        self.assertIsNone(evidence["http_status"])
        self.assertIsNone(evidence["response_body"])
        self.assertNotIn("private input", message)

    def test_unreadable_error_body_does_not_erase_http_status(self) -> None:
        stream = Mock()
        stream.closed = False
        stream.read.side_effect = TimeoutError("fixture body timeout")
        error = HTTPError("http://127.0.0.1/add", 503, "fixture error", Message(), stream)
        with patch.object(MODULE, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            evidence, _ = self.failure_diagnostic()
        self.assertEqual(evidence["http_status"], 503)
        self.assertEqual(evidence["body_read_error"], "TimeoutError")
        self.assertIsNone(evidence["error_code"])

    def test_namespace_and_token_are_required(self) -> None:
        for key in ("NMG_OMNI_API_NAMESPACE", "NMG_OMNI_API_TOKEN"):
            with patch.dict(os.environ, {key: ""}):
                with self.assertRaisesRegex(ValueError, key):
                    MODULE.NmgClient()


if __name__ == "__main__":
    unittest.main()
