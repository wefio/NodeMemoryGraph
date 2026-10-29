/* eslint-disable no-console -- deliberate test/diagnostic output */
/* Verifies the log accept path end to end: durable accept, replay, fold, and that a
 * search sees an entry that has not been folded yet. Runs against the built worker
 * with a stub embedding endpoint, so no model or network is involved. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createWorkerFixture } from "./worker-fixture.mjs";

// Per-process directory: on Windows a previous run's Miniflare can still hold a handle
// on the shared path and the cleanup fails with EPERM before any test runs. The retries
// cover the case where the handle is released a moment later.
const storage = path.join(process.cwd(), ".runtime/tests/log-mode-r2-" + process.pid);
fs.rmSync(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
/** Every embedding call the worker makes, so a test can assert how the work is batched. */
const embedCalls = [];
const outboundService = async (request) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/embeddings")) return new Response("not found", { status: 404 });
  const body = await request.json();
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  embedCalls.push(inputs);
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
async function call(route, body, headers = {}) {
  const response = await worker.fetch("http://localhost" + route, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
      ...headers,
    },
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
  // The fixture overrides the mode, so the code default is pinned at the source instead: a
  // future edit must not quietly put production back on the synchronous path.
  {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../backend/worker.mjs"),
      "utf8",
    );
    assert.match(
      source,
      /const addMode = \(env\) => \(env\.NMG_ADD_MODE === "sync" \? "sync" : "log"\)/,
      "the code default must be the log path, with NMG_ADD_MODE=sync as the escape hatch",
    );
  }
  assert.equal(health.body.limits.add_mode, "log", "the fixture must run the log path");
  {
    // A missing seventh argument is invisible at runtime: the signature defaults to null, the
    // snapshot is re-uploaded on every CAS retry, and only a bucket listing shows it. The same
    // reason the add-mode default is pinned here applies to a call-site argument.
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../backend/worker.mjs"),
      "utf8",
    );
    assert.match(
      source,
      /async \(\{ sqlite, key, manifest, staged, reuse \}\)/,
      "the search operation must receive the attempt's reuse map",
    );
    assert.match(
      source,
      /options\.fullSnapshot \|\| env\.NMG_SEARCH_DELTAS === "0",[\s\S]{0,400}?reuse,/,
      "stageSearchPart must be given the reuse map, or a retry re-uploads an identical snapshot",
    );
    // The two budgets are what keep a request from being killed at the platform ceiling. A
    // killed request loses the whole evaluation attempt, so their removal has to fail a test:
    // the entry is durable before the fold, and a partial page is worth more than no answer.
    assert.match(
      source,
      /const dueBySchedule =[\s\S]{0,240}?if \(dueBySchedule && Date\.now\(\) - startedAt < foldBudget\)/,
      "the fold must be scheduled and budgeted; unbounded, a contended user folds past 120 s",
    );
    // The root fix: an accept takes no compare-and-swap at all. Sixteen concurrent Adds on one
    // user used to serialise on the manifest and lose twelve times each, redoing a megabyte of
    // partition work per retry; that is what took a write from 0.5 s to 51-106 s. If a future
    // edit routes the accept through `mutateUser` again, this fails.
    {
      const start = source.indexOf("async function acceptAdd(env, input) {");
      const end = source.indexOf("/** Folds waiting entries into the partition");
      const body = source.slice(start, end);
      assert.ok(start > 0 && end > start, "acceptAdd must still exist");
      for (const forbidden of ["mutateUser(", "commitManifest(", "setPending("])
        assert.ok(
          !body.includes(forbidden),
          `accept must write nothing but its log entry; found ${forbidden}`,
        );
    }
    // And the read path must not trust a zero hint, or accepted data becomes invisible.
    assert.ok(
      !/async function pendingForSearch\(env, ctx, limit\) \{\s*if \(pendingCount\(ctx\.manifest\) === 0\)/.test(
        source,
      ),
      "the pending read must not short-circuit on the hint",
    );
    assert.match(
      source,
      /if \(Date\.now\(\) - started > searchDeadline\) \{\s*partial = true;\s*break;/,
      "the partition loop must stop at a deadline and mark the page partial",
    );
    assert.match(source, /partial,/, "the response must say whether the page is partial");
    // Spend is bounded per request, not per record: the fold's backfill must cap its batches, or
    // one fold embeds a whole partition's backlog and is charged for it.
    {
      const service = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../backend/memory-service.ts"),
        "utf8",
      );
      assert.match(
        service,
        /syncRecordEmbeddings\(this\.store, this\.client, 32, \{ maxBatches: 1 \}\)/,
        "both backfill call sites must cap their batches",
      );
      assert.equal(
        (service.match(/syncRecordEmbeddings\(this\.store, this\.client, 32\)/g) ?? []).length,
        0,
        "the unbounded backfill form must not come back",
      );
    }
  }

  // I1: accepted Add is searchable before any fold.
  const first = await call(
    "/add",
    addBody("alice", "req-1", "the spare key is under the blue planter"),
  );
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
  const replay = await call(
    "/add",
    addBody("alice", "req-1", "the spare key is under the blue planter"),
  );
  assert.deepEqual(replay.body, first.body, "a replay must return the stored response");
  const conflict = await call("/add", addBody("alice", "req-1", "different content entirely"));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "request_id_reused");

  // Fold: enough accepts trip the trigger, and everything stays searchable.
  for (let index = 0; index < 30; index += 1)
    await call(
      "/add",
      addBody("alice", `bulk-${index}`, `filler turn number ${index} about the garden`),
    );
  const afterFold = await call("/search", {
    user_id: "alice",
    query: "spare key under the blue planter",
    top_k: 50,
  });
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
  const replayAfterFold = await call(
    "/add",
    addBody("alice", "req-1", "the spare key is under the blue planter"),
  );
  assert.deepEqual(replayAfterFold.body, first.body, "replay must survive folding");

  // The counter is observable, and draining it is an operation, not a side effect:
  // without this the burst would settle above zero forever and a search would list
  // the log on every request.
  const waiting = await call("/capacity?user_id=alice");
  assert.ok(waiting.body.pending_entries > 0, "the burst must leave entries waiting");
  // The counter is a derivation, not a history: after the burst's folds it must equal
  // the number of entries actually in the log. Subtraction would drift here on a CAS
  // retry, and a count below the log hides accepted data.
  {
    const key = createHash("sha256").update("alice").digest("hex").slice(0, 24);
    const liveBucket = await mf.getR2Bucket("MEMORY", "a");
    const listed = await liveBucket.list({ prefix: `users/${key}/log/` });
    assert.equal(
      waiting.body.pending_entries,
      listed.objects.length,
      "the counter must equal the number of log entries",
    );
  }
  const drain = await call(
    "/admin/fold?user_id=alice",
    {},
    {
      "oai-authenticated-user-email": "owner@example.test",
      origin: "http://localhost",
    },
  );
  assert.equal(drain.status, 200, JSON.stringify(drain.body));
  assert.ok(drain.body.folded > 0, "draining must fold something");
  const drained = await call("/capacity?user_id=alice");
  assert.equal(
    drained.body.pending_entries,
    0,
    `draining must zero the counter: drain=${JSON.stringify(drain.body)} before=${waiting.body.pending_entries} after=${drained.body.pending_entries}`,
  );
  // A drain is a verification, not an attempt: the runbook gates a rollback on it, so
  // "clean" must be distinguishable from "ran out of rounds".
  assert.equal(drain.body.success, true, "a drained log must report success");
  const again = await call(
    "/admin/fold?user_id=alice",
    {},
    {
      "oai-authenticated-user-email": "owner@example.test",
      origin: "http://localhost",
    },
  );
  assert.equal(again.status, 200, "draining an already clean log stays 200");
  assert.equal(again.body.remaining, 0);
  assert.equal(again.body.folded, 0);
  const afterDrain = await call("/search", {
    user_id: "alice",
    query: "spare key under the blue planter",
    top_k: 50,
  });
  const drainedRecord = afterDrain.body.data.find((item) =>
    String(item.content).includes("spare key"),
  );
  assert.ok(drainedRecord, "a drained entry must still be searchable");
  assert.ok(
    !String(drainedRecord.id).startsWith("pending:"),
    "a drained entry must be served by the partition",
  );

  // Residue: an empty log with a non-zero counter is what a reservation whose write
  // never landed leaves behind. Nothing else notices it, because the fold is only
  // triggered by that counter, so the drain has to release it - and report the count
  // *after* the release, or the last call of a full round budget answers 409.
  const bucket = await mf.getR2Bucket("MEMORY", "a");
  const owner = {
    "oai-authenticated-user-email": "owner@example.test",
    origin: "http://localhost",
  };
  async function seedPendingCounter(userId, pending) {
    const key = createHash("sha256").update(userId).digest("hex").slice(0, 24);
    await bucket.put(
      `users/${key}/manifest.json`,
      JSON.stringify({ format: "nmg-shards-v4", parts: [], receipts: {}, pending }),
    );
  }
  await seedPendingCounter("residue-one", 1);
  const residueOne = await call("/admin/fold?user_id=residue-one", {}, owner);
  assert.equal(residueOne.status, 200, JSON.stringify(residueOne.body));
  assert.equal(residueOne.body.remaining, 0, "a single residue slot must report clean");
  assert.equal(residueOne.body.released, 1);

  // Nine slots exceed one drain pass, so the first call must say "not clean" rather
  // than claim success it cannot back up.
  await seedPendingCounter("residue-nine", 9);
  const partial = await call("/admin/fold?user_id=residue-nine", {}, owner);
  assert.equal(partial.status, 409, JSON.stringify(partial.body));
  assert.equal(partial.body.success, false);
  assert.equal(partial.body.remaining, 1, "one slot is left after a full pass");
  const finished = await call("/admin/fold?user_id=residue-nine", {}, owner);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.remaining, 0);

  // The read window must cover everything that is waiting. With the fold trigger at one
  // batch, a run of Adds leaves at most a batch pending, so every accepted fact stays
  // searchable - the failure this pins is a standing backlog larger than the window, which
  // hid whichever end the window did not take.
  {
    const windowUser = "window-" + process.pid;
    const markers = [];
    for (let index = 0; index < 20; index += 1) {
      const content = `marker ${index} says the vault code is ${2000 + index}`;
      markers.push(content);
      const added = await call("/add", addBody(windowUser, `win-${index}`, content));
      assert.equal(added.status, 200, JSON.stringify(added.body));
    }
    const windowCapacity = await call(`/capacity?user_id=${windowUser}`);
    assert.ok(
      windowCapacity.body.pending_entries < 8,
      `pending must stay below the read window, got ${windowCapacity.body.pending_entries}`,
    );
    for (const [index, content] of markers.entries()) {
      const found = await call("/search", {
        user_id: windowUser,
        query: `vault code ${2000 + index}`,
        top_k: 100,
      });
      assert.ok(
        (found.body.data ?? []).some((item) => String(item.content).includes(content)),
        `marker ${index} must be searchable while the log is live`,
      );
    }
  }

  // One search embeds every pending record in a single call, and its features in another.
  // The sequential version spent a round trip per text - thirty or more inside one search -
  // which is how a slow provider ran into the invocation ceiling instead of costing a score.
  {
    const batchUser = "batch-" + process.pid;
    for (let index = 0; index < 4; index += 1) {
      const content = `batch marker ${index} records the tidepier${index} gauge reading`;
      const added = await call("/add", addBody(batchUser, `batch-${index}`, content));
      assert.equal(added.status, 200, JSON.stringify(added.body));
    }
    embedCalls.length = 0;
    const found = await call("/search", {
      user_id: batchUser,
      query: "tide table pier",
      top_k: 20,
    });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    // The rendered record text may carry a date and role prefix, so the marker token identifies
    // it. How many of the four are still pending depends on the fold schedule, which is a rate
    // rather than a counter, so the count is not pinned here - the shape is: pending records
    // reach the provider inside one call, not one call per record.
    assert.ok(
      embedCalls.some((inputs) => inputs.some((text) => /tidepier\d/.test(text))),
      `pending records must reach the provider; saw ${embedCalls
        .map((inputs) => inputs.length)
        .join("/")}`,
    );
    assert.ok(
      embedCalls.length <= 2,
      `one batch per purpose; saw ${embedCalls.length} calls with ${embedCalls
        .map((inputs) => inputs.length)
        .join("/")} inputs`,
    );
  }

  // A search embeds its features in one call, not one per feature: the engine asks for a single
  // feature at a time, so the cache is keyed by text and the warm pass fetches them together.
  {
    const featureUser = "features-" + process.pid;
    for (let index = 0; index < 3; index += 1) {
      const added = await call(
        "/add",
        addBody(
          featureUser,
          `feat-${index}`,
          `feature marker ${index} about harbour tide ${index}`,
        ),
      );
      assert.equal(added.status, 200, JSON.stringify(added.body));
    }
    embedCalls.length = 0;
    const found = await call("/search", {
      user_id: featureUser,
      query: "harbour tide levels and the engineering notes from the second session",
      top_k: 20,
    });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.ok(
      embedCalls.length <= 2,
      `one batch per purpose; saw ${embedCalls.length} calls with ${embedCalls
        .map((inputs) => inputs.length)
        .join("/")} inputs`,
    );
  }

  // The vectors travel with the entry, so the fold must not buy them again. The observable is the
  // provider call count: an Add makes at most one call - its own inline embed - even when it is
  // the Add that triggers a fold. Without the seed the fold would add a second call for the same
  // text, which is the serialisation the whole change exists to remove.
  {
    const inlineUser = "inline-" + process.pid;
    let worst = 0;
    for (let index = 0; index < 24; index += 1) {
      const before = embedCalls.length;
      const added = await call(
        "/add",
        addBody(inlineUser, `inline-${index}`, `inline marker ${index} about the tide gauge`),
      );
      assert.equal(added.status, 200, JSON.stringify(added.body));
      worst = Math.max(worst, embedCalls.length - before);
    }
    assert.equal(
      worst,
      1,
      `an Add must embed its own messages once and the fold must reuse them; saw ${worst} calls`,
    );
    // The assertion above is only meaningful if a fold actually ran, so prove it did: some of the
    // 24 entries are on disk and the backlog is smaller than the log.
    const afterFolds = await call(`/capacity?user_id=${inlineUser}`);
    assert.ok(
      (afterFolds.body.sqlite_bytes?.used ?? 0) > 0,
      "a fold must have written a partition during the loop",
    );
    assert.ok(
      (afterFolds.body.pending_entries ?? 99) < 24,
      "a fold must have drained part of the log during the loop",
    );
  }

  // With a provider configured, the private status answers which endpoint and which vector
  // space are live - the question that had to be guessed three times during the 2026-10-29
  // incidents.
  {
    const status = await call("/admin/status", undefined, {
      "oai-authenticated-user-email": "owner@example.test",
    });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.embedding.configured, true);
    assert.equal(status.body.embedding.endpoint, "https://embed.test/v1");
    assert.equal(status.body.embedding.model, "bge-small-en-v1.5");
    assert.match(status.body.embedding.index_id, /^.+@[0-9a-f]{12}$/);
    assert.equal(status.body.embedding.dimensions, DIMENSIONS);
    assert.ok(!JSON.stringify(status.body).includes("test-key"));
    console.log("PASS: the private status reports the live endpoint, model and index identity.");
  }

  // Reset drains the log as well as the partitions.
  const reset = await call("/reset", {
    user_id: "alice",
    confirm_user_id: "alice",
    reset_id: `reset-${++counter}`,
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const afterReset = await call("/search", { user_id: "alice", query: "spare key", top_k: 20 });
  assert.equal(afterReset.body.data.length, 0, "reset must remove pending and folded data");

  console.log(
    "PASS: an Add accepted into the log is searchable before folding, replays byte-identically, survives the fold, conflicts on different content, and reset drains it.",
  );
} finally {
  await mf.dispose();
}
