// Retry observability: the official client retries a failed call up to
// `max_retries` times (default 4, so five attempts) and only the successful
// attempt reaches TokenTracker. A retry that the provider already billed —
// a timeout or a 502 after generation — is therefore invisible in the token
// report. These tests pin the counter that makes those attempts visible.

import assert from "node:assert/strict";
import test from "node:test";

import { createRetryCapture } from "../../evals/omnimemeval/retry-observability.ts";

test("counts OFFICIAL retry warnings per module", () => {
  const capture = createRetryCapture();
  capture.push("  ⚠ [ANSWER] LLM retry 1/4: APITimeoutError: request timed out\n");
  capture.push("  ⚠ [ANSWER] LLM retry 2/4: InternalServerError: upstream 502\n");
  capture.push("  ⚠ [EVAL] LLM retry 1/4: APITimeoutError: request timed out\n");
  const report = capture.report();
  assert.equal(report.totalRetries, 3);
  assert.equal(report.byModule.ANSWER.retries, 2);
  assert.equal(report.byModule.ANSWER.maxAttemptSeen, 2);
  assert.equal(report.byModule.EVAL.retries, 1);
});

test("keeps a warning split across stdout chunks", () => {
  const capture = createRetryCapture();
  capture.push("  ⚠ [ANSWER] LLM retr");
  capture.push("y 1/4: APITimeoutError: request timed out\n");
  assert.equal(capture.report().totalRetries, 1);
});

test("ignores ordinary progress output and reports an empty run", () => {
  const capture = createRetryCapture();
  capture.push("[ANSWER] model=deepseek-v4-flash\nsearched 100/1540\n");
  const report = capture.report();
  assert.equal(report.totalRetries, 0);
  assert.deepEqual(report.byModule, {});
  // A run without retries must still produce a report rather than crash.
  assert.equal(report.attemptsPerCall, null);
});

test("derives attempts per call from the successful-call count", () => {
  const capture = createRetryCapture();
  capture.push("  ⚠ [ANSWER] LLM retry 1/4: APITimeoutError: request timed out\n");
  const report = capture.report({ ANSWER: 1540 });
  assert.equal(report.byModule.ANSWER.retries, 1);
  assert.equal(report.byModule.ANSWER.calls, 1540);
  // 1540 successful calls + 1 retried attempt = 1541 attempts for 1540 answers.
  assert.equal(report.byModule.ANSWER.attemptsPerCall, 1.0006);
});
