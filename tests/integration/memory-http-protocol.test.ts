import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpError,
  memoryHttpOperation,
  readHttpAdd,
  readHttpClauses,
  readHttpJson,
  readHttpNow,
  readHttpTopK,
  requireHttpApiKey,
} from "../../src/integration/memory-http-protocol.ts";
import { decodedImageBytes } from "../../src/integration/multimodal-content.ts";

const endpoint = "http://127.0.0.1:8787";
const sample = {
  user_id: "fixture-user",
  session_id: "fixture-session",
  request_id: "fixture-request",
  messages: [{ role: "user", content: "The session starts at noon.", timestamp: 1700000000000 }],
};

test("memory HTTP routes enforce their methods", () => {
  assert.equal(memoryHttpOperation("GET", "/health"), "health");
  assert.equal(memoryHttpOperation("HEAD", "/health"), "health");
  assert.equal(memoryHttpOperation("POST", "/add"), "add");
  assert.equal(memoryHttpOperation("POST", "/search"), "search");
  assert.equal(memoryHttpOperation("POST", "/health"), undefined);
  assert.equal(memoryHttpOperation("GET", "/search"), undefined);
  assert.equal(memoryHttpOperation("POST", "/remember"), undefined);
});

test("HTTP authentication accepts all supported schemes and distinguishes configuration errors", () => {
  const key = "unit-fixture-key";
  const request = (headers: HeadersInit = {}) => new Request(endpoint + "/search", { headers });
  for (const headers of [
    { authorization: `Bearer ${key}` },
    { authorization: `Token ${key}` },
    { "x-api-key": key },
  ] as HeadersInit[]) {
    assert.doesNotThrow(() => requireHttpApiKey(request(headers), key));
  }

  assert.throws(() => requireHttpApiKey(request(), key), { status: 401, code: "unauthorized" });
  assert.throws(() => requireHttpApiKey(request({ authorization: "Bearer wrong" }), key), {
    status: 401,
    code: "unauthorized",
  });
  assert.throws(() => requireHttpApiKey(request(), undefined), {
    status: 503,
    code: "not_configured",
  });
});

test("Add aliases and equivalent timestamp inputs retain the same receipt identity", () => {
  const canonical = readHttpAdd(sample);
  const equivalent = readHttpAdd({
    userId: sample.user_id,
    conversationId: sample.session_id,
    request_id: sample.request_id,
    messages: [
      {
        role: "user",
        content: sample.messages[0].content,
        chat_time: "2023-11-14T22:13:20.000Z",
      },
    ],
  });
  const different = readHttpAdd({
    ...sample,
    messages: [{ ...sample.messages[0], content: "The session starts at two." }],
  });

  assert.deepEqual(canonical.messages, equivalent.messages);
  assert.equal(canonical.messages[0].chat_time, "2023-11-14T22:13:20.000Z");
  assert.equal(canonical.requestHash, equivalent.requestHash);
  assert.equal(canonical.fingerprint, equivalent.fingerprint);
  assert.equal(canonical.requestHash, different.requestHash);
  assert.notEqual(canonical.fingerprint, different.fingerprint);
});

test("Add rejects an incomplete batch, invalid role or date, and excess messages", () => {
  for (const [input, message] of [
    [{ ...sample, request_id: "" }, /request_id/u],
    [{ ...sample, messages: [] }, /between 1 and 512 messages/u],
    [{ ...sample, messages: [{ ...sample.messages[0], role: "system" }] }, /user or assistant/u],
    [{ ...sample, messages: [{ ...sample.messages[0], timestamp: 1e30 }] }, /Unix milliseconds/u],
    [
      { ...sample, messages: [{ ...sample.messages[0], chat_time: "later" }] },
      /valid date string/u,
    ],
  ] as const) {
    assert.throws(() => readHttpAdd(input), { status: 400, code: "invalid_request", message });
  }
  assert.throws(
    () => readHttpAdd({ ...sample, messages: [...sample.messages, ...sample.messages] }, 1),
    {
      status: 400,
      code: "invalid_request",
      message: /between 1 and 1 messages/u,
    },
  );
});

test("top_k accepts explicit bounds, the legacy alias and a local default", () => {
  assert.equal(readHttpTopK({ top_k: 1, topK: 20 }, 2), 1);
  assert.equal(readHttpTopK({ topK: 100 }), 100);
  assert.equal(readHttpTopK({}, 3), 3);
  for (const top_k of [undefined, 0, 101, 1.5, "1"]) {
    assert.throws(() => readHttpTopK({ top_k }), { status: 400, code: "invalid_request" });
  }
});

test("Search keeps the first clause label and expands distinct legacy options in order", async () => {
  assert.deepEqual(
    await readHttpClauses({
      queries: [
        { text: "anchor", name: "primary" },
        { text: "anchor", name: "duplicate" },
        { query: "nearby context", mode: "append" },
      ],
    }),
    [
      { text: "anchor", name: "primary", appendOnly: false },
      { text: "nearby context", name: null, appendOnly: true },
    ],
  );
  assert.deepEqual(
    (await readHttpClauses({ query: "meeting", options: ["morning", "afternoon", "morning"] })).map(
      ({ text }) => text,
    ),
    ["meeting", "meeting morning", "meeting afternoon"],
  );
});

test("Search rejects mixed query forms and a supplemental presentation clause", async () => {
  for (const [input, message] of [
    [{ query: "first", queries: ["second"] }, /queries and query cannot be combined/u],
    [{ options: ["first"], queries: ["second"] }, /queries and options cannot be combined/u],
    [{ queries: [{ text: "first", appendOnly: true }, "second"] }, /first clause/u],
  ] as const) {
    await assert.rejects(readHttpClauses(input), { status: 400, code: "invalid_request", message });
  }
});

test("HTTP JSON accepts complete objects within the byte limit and rejects malformed bodies", async () => {
  const request = (body?: string) => new Request(endpoint + "/add", { method: "POST", body });
  const value = { note: "早上" };
  const serialized = JSON.stringify(value);
  const bytes = new TextEncoder().encode(serialized).length;
  assert.deepEqual(await readHttpJson(request(serialized), bytes, 1000), value);
  await assert.rejects(readHttpJson(request(serialized), bytes - 1, 1000), {
    status: 413,
    code: "request_too_large",
  });
  for (const body of [undefined, "null", "[]", "{"]) {
    await assert.rejects(readHttpJson(request(body), 100, 1000), {
      status: 400,
      code: "invalid_json",
    });
  }
});

test("HTTP JSON rejects both an oversized declaration and an oversized chunked upload", async () => {
  const declared = new Request(endpoint + "/add", {
    method: "POST",
    headers: { "content-length": "20" },
    body: "{}",
  });
  await assert.rejects(readHttpJson(declared, 10, 1000), {
    status: 413,
    code: "request_too_large",
  });

  let cancelled = false;
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":'));
        controller.enqueue(new TextEncoder().encode('"oversized"}'));
      },
      cancel() {
        cancelled = true;
      },
    }),
  };
  await assert.rejects(readHttpJson(new Request(endpoint + "/add", init), 12, 1000), {
    status: 413,
    code: "request_too_large",
  });
  assert.equal(cancelled, true);
});

test("readHttpNow parses Unix ms and ISO timestamps and rejects invalid values", () => {
  assert.equal(readHttpNow({}), undefined);
  assert.equal(readHttpNow({ now: null }), undefined);
  assert.equal(readHttpNow({ now: 1704067200000 }), "2024-01-01T00:00:00.000Z");
  assert.equal(
    readHttpNow({ current_time: "2026-10-30T13:39:00+08:00" }),
    "2026-10-30T13:39:00+08:00",
  );
  assert.equal(readHttpNow({ timestamp: "2026-10-30T05:39:00Z" }), "2026-10-30T05:39:00Z");
  for (const invalid of [
    { now: "" },
    { now: "2026-10-30" },
    { now: "2026-02-31T10:00:00Z" },
    { now: Number.NaN },
    { now: true },
  ]) {
    assert.throws(() => readHttpNow(invalid), { status: 400, code: "invalid_request" });
  }
});

test("readHttpAdd enforces nonempty text parts and 10 MiB / 30 MiB AML image budgets", () => {
  const tinyImage = {
    type: "image_url",
    image_url: {
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
    },
  };
  assert.throws(
    () =>
      readHttpAdd({
        ...sample,
        messages: [{ role: "user", content: [{ type: "text", text: "" }, tinyImage] }],
      }),
    (error: unknown) =>
      error instanceof HttpError && error.status === 400 && error.code === "invalid_content",
  );

  const eightMiB = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from("89504e470d0a1a0a", "hex").copy(eightMiB);
  const largeImage = {
    type: "image_url" as const,
    image_url: { url: `data:image/png;base64,${eightMiB.toString("base64")}` },
  };
  assert.equal(decodedImageBytes([largeImage]), 8 * 1024 * 1024);

  const allowed = readHttpAdd({
    ...sample,
    messages: Array.from({ length: 3 }, () => ({ role: "user", content: [largeImage] })),
  });
  assert.equal(allowed.messages.length, 3);

  assert.throws(
    () =>
      readHttpAdd({
        ...sample,
        messages: Array.from({ length: 4 }, () => ({ role: "user", content: [largeImage] })),
      }),
    { status: 413, code: "request_too_large" },
  );
});
