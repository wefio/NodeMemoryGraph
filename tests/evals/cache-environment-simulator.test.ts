import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrefixCheckpoints,
  simulateCacheEnvironment,
  type CacheEnvironment,
  type PromptTraceRequest,
} from "../../evals/omnimemeval/research/probes/cache-environment-simulator.ts";
import { createFakeCacheApi } from "../../evals/omnimemeval/research/probes/fake-cache-api.ts";

const environment: CacheEnvironment = {
  concurrency: 2,
  networkRttMs: 0,
  networkJitterMs: 0,
  cacheLookupMs: 0,
  cacheBuildMs: 100,
  cacheTtlMs: 10_000,
  prefillMsPerKb: 0,
  decodeMsPerToken: 0,
};

function request(id: string, arrivalMs: number, suffix: string): PromptTraceRequest {
  const body = `0123456789abcdef${suffix}`;
  return { id, arrivalMs, ...buildPrefixCheckpoints(body, 8) };
}

test("fixed-byte chains expose only same-length prefix hashes", () => {
  const left = request("left", 0, "left");
  const right = request("right", 0, "right");

  assert.deepEqual(left.checkpoints.slice(0, 2), right.checkpoints.slice(0, 2));
  assert.notEqual(left.requestHash, right.requestHash);
  assert.deepEqual(left.checkpoints.map((checkpoint) => checkpoint.length), [8, 16, 20]);
  assert.ok(!JSON.stringify(left).includes("0123456789abcdef"));
});

test("requests arriving while a shared prefix is building miss, then a later request hits", () => {
  const report = simulateCacheEnvironment(
    [request("a", 0, "aaaa"), request("b", 0, "bbbb"), request("c", 101, "cccc")],
    environment,
  );

  assert.equal(report.requests, 3);
  assert.deepEqual(report.environment, environment);
  assert.equal(report.hitRequests, 1);
  assert.equal(report.coldWaveMisses, 1);
  assert.equal(report.requestResults[2]?.reusablePrefixBytes, 16);
});

test("expired prefixes no longer count as reusable", () => {
  const report = simulateCacheEnvironment(
    [request("a", 0, "aaaa"), request("b", 51, "bbbb")],
    { ...environment, concurrency: 1, cacheBuildMs: 0, cacheTtlMs: 50 },
  );

  assert.equal(report.hitRequests, 0);
  assert.equal(report.reusablePrefixBytes, 0);
});

test("fake API accepts ordinary chat requests and reports hashes without prompt text", async (context) => {
  const api = createFakeCacheApi({ blockBytes: 8 });
  api.server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.server.once("listening", resolve));
  context.after(() => api.server.close());
  const address = api.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const prompt = "private prompt must not appear in the report";
  const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: prompt }] });

  const completion = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(completion.status, 200);
  const completionBody = await completion.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(completionBody.choices[0]?.message.content, "CACHE_TRACE_ONLY");

  const reportResponse = await fetch(`${baseUrl}/__cache/report?profile=local`);
  const reportText = await reportResponse.text();
  const report = JSON.parse(reportText) as { requests: number; blockBytes: number };
  assert.equal(report.requests, 1);
  assert.equal(report.blockBytes, 8);
  assert.ok(!reportText.includes(prompt));
  assert.ok(!JSON.stringify(api.traces).includes(prompt));
});
