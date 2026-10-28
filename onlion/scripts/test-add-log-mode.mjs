/* Verifies the log accept path end to end: durable accept, replay, fold, and that a
 * search sees an entry that has not been folded yet. Runs against the built worker
 * with a stub embedding endpoint, so no model or network is involved. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorkerFixture } from "./worker-fixture.mjs";

const storage = path.join(process.cwd(), ".runtime/tests/log-mode-r2");
fs.rmSync(storage, { recursive: true, force: true });
const DIMENSIONS = 8;
/** Deterministic unit vector per text, so a record and the query that names it
 *  produce the same direction. */
function vector(text) {
  const raw = new Array(DIMENSIONS).fill(0);
  for (const [index, char] of [...String(text)].entries())
    raw[index % DIMENSIONS] += (char.charCodeAt(0) % 17) - 8;
  const norm = Math.hypot(...raw) || 1;
  return raw.map((value) => Number((value / norm).toFixed(6)));
}
const outboundService = async (request) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/embeddings")) return new Response("not found", { status: 404 });
  const body = await request.json();
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return new Response(
    JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: vector(text) })) }),
    { headers: { "content-type": "application/json" } },
  );
};

const mf = createWorkerFixture({
  storage,
  outboundService,
  bindings: {
    NMG_ADD_MODE: "log",
    NMG_DEBUG_ERRORS: "1",
    NMG_EMBED_BASE_URL: "https://embed.test/v1",
    NMG_EMBED_MODEL: "BAAI/bge-small-en-v1.5",
    NMG_EMBED_DIMENSIONS: String(DIMENSIONS),
  },
});
const worker = await mf.getWorker("a");
let counter = 0;
async function call(route, body) {
  const response = await worker.fetch("http://localhost" + route, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}
function addBody(userId, requestId, content, sessionId = "s") {
  return {
    user_id: userId,
    session_id: sessionId,
    request_id: requestId,
    messages: [
      { role: "user", content },
      { role: "assistant", content: "noted" },
    ],
  };
}

try {
  const health = await call("/health");
  assert.equal(health.body.limits.add_mode, "log", "the fixture must run the log path");

  // I1: accepted Add is searchable before any fold.
  const first = await call("/add", addBody("alice", "req-1", "the spare key is under the blue planter"));
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 900));
  assert.equal(first.body.status, "completed");
  const seen = await call("/search", { user_id: "alice", query: "spare key", top_k: 20 });
  assert.equal(seen.status, 200);
  assert.ok(
    seen.body.data.some((item) => String(item.content).includes("spare key")),
    "an accepted but unfolded entry must be searchable",
  );
  assert.ok(
    seen.body.data.some((item) => String(item.id).startsWith("pending:")),
    "the entry is served from the log, not the partition",
  );

  // I2: replay returns the same body; different content for the same id is 409.
  const replay = await call("/add", addBody("alice", "req-1", "the spare key is under the blue planter"));
  assert.deepEqual(replay.body, first.body, "a replay must return the stored response");
  const conflict = await call("/add", addBody("alice", "req-1", "different content entirely"));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "request_id_reused");

  // Fold: enough accepts trip the trigger, and everything stays searchable.
  for (let index = 0; index < 30; index += 1)
    await call("/add", addBody("alice", `bulk-${index}`, `filler turn number ${index} about the garden`));
  const afterFold = await call("/search", { user_id: "alice", query: "spare key under the blue planter", top_k: 50 });
  assert.equal(afterFold.status, 200);
  const keyRecord = afterFold.body.data.find((item) => String(item.content).includes("spare key"));
  assert.ok(keyRecord, "a folded entry must remain searchable");
  // The first Add is the oldest entry, so the first fold that ran during the burst
  // absorbed it. Serving it from the partition rather than from the log is the only
  // thing that proves folding happened at all - a run where foldPending silently
  // did nothing still answered every other assertion in this file.
  assert.ok(
    !String(keyRecord.id).startsWith("pending:"),
    `the oldest entry must have been folded, got ${keyRecord.id}`,
  );

  // I2 after folding: the receipt now lives in the partition.
  const replayAfterFold = await call("/add", addBody("alice", "req-1", "the spare key is under the blue planter"));
  assert.deepEqual(replayAfterFold.body, first.body, "replay must survive folding");

  // Reset drains the log as well as the partitions.
  const reset = await call("/reset", { user_id: "alice", confirm_user_id: "alice", reset_id: `reset-${++counter}` });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const afterReset = await call("/search", { user_id: "alice", query: "spare key", top_k: 20 });
  assert.equal(afterReset.body.data.length, 0, "reset must remove pending and folded data");

  console.log(
    "PASS: an Add accepted into the log is searchable before folding, replays byte-identically, survives the fold, conflicts on different content, and reset drains it.",
  );
} finally {
  await mf.dispose();
}
