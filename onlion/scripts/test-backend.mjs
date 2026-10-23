/* eslint-disable no-console -- deliberate test/diagnostic output */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorkerFixture } from "./worker-fixture.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { applyPageDelta, makePageDelta } from "../backend/page-delta.mjs";
const root = process.cwd();
const storage = path.join(root, ".runtime/tests/backend-r2");
const python = process.env.NMG_TEST_PYTHON ?? "python";
fs.rmSync(storage, { recursive: true, force: true });
function start() {
  return createWorkerFixture({ storage });
}
let mf = start();
async function call(name, route, body, key = "test-key", extraHeaders = {}) {
  if (route === "/add" && body)
    body = {
      session_id: "test-session",
      ...body,
      messages: body.messages?.map((m) => ({ role: "user", ...m })),
    };
  if (route === "/search" && body) body = { top_k: 10, ...body };
  const worker = await mf.getWorker(name);
  const r = await worker.fetch("http://localhost" + route, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/json",
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, body: parsed };
}
try {
  assert.equal((await call("a", "/health")).status, 200);
  assert.equal(
    (await call("a", "/search", { user_id: "alice", query: "robot" }, "wrong")).status,
    401,
  );
  const authWorker = await mf.getWorker("a");
  for (const headers of [
    { authorization: "Token test-key" },
    { authorization: "Bearer test-key" },
    { "x-api-key": "test-key" },
  ]) {
    const authenticated = await authWorker.fetch(
      "http://localhost/capacity?user_id=auth-contract",
      { headers },
    );
    assert.equal(authenticated.status, 200, JSON.stringify(await authenticated.json()));
  }
  assert.equal(
    (
      await authWorker.fetch("http://localhost/health", {
        headers: { authorization: "Token wrong" },
      })
    ).status,
    200,
    "Health remains unauthenticated under every credential value",
  );
  assert.equal((await call("a", "/add", { user_id: "alice", messages: [] })).status, 400);
  // Same-session chunks must keep distinct source-message identities, even
  // without an intervening search. Run both persistence modes as well.
  for (const mode of ["no_search", "delta", "snapshot"]) {
    const uid = "streaming-" + mode,
      headers = {
        "oai-authenticated-user-email": "owner@example.test",
        origin: "http://localhost",
      };
    const input = {
      user_id: uid,
      session_id: "same-session",
      request_id: "stream-0",
      messages: [{ role: "user", content: "stream-probe robot alpha", timestamp: 1704067200000 }],
    };
    const first = await call("a", "/add", input);
    assert.equal(first.status, 200, JSON.stringify(first));
    for (let i = 1; i <= 2; i++) {
      if (mode !== "no_search")
        assert.equal(
          (
            await call(
              "b",
              "/admin/diagnostics/search",
              {
                user_id: uid,
                query: "stream-probe robot",
                top_k: 10,
                repetitions: 1,
                persistence: mode,
              },
              "test-key",
              headers,
            )
          ).status,
          200,
        );
      const next = await call("a", "/add", {
        ...input,
        request_id: "stream-" + i,
        messages: [
          {
            role: i % 2 ? "assistant" : "user",
            content: "stream-probe robot " + ["alpha", "beta", "gamma"][i],
            timestamp: 1704067200000 + i * 1000,
          },
        ],
      });
      assert.equal(next.status, 200, mode + ": " + JSON.stringify(next));
    }
    const retry = await call("b", "/add", input);
    assert.deepEqual(retry, first);
    const searched = await call("a", "/search", {
      user_id: uid,
      query: "stream-probe robot",
      top_k: 100,
    });
    assert.equal(searched.status, 200);
    assert.equal(searched.body.data.length, 3);
  }
  console.log(
    "PASS: same-session Add/Add and two Add/Search/Add rounds in delta and snapshot modes.",
  );
  const profileInput = { user_id: "streaming-delta", query: "stream-probe robot", top_k: 3 };
  const profiled = await call("a", "/search", profileInput, "test-key", { "x-nmg-profile": "1" });
  assert.equal(profiled.status, 200);
  assert.ok(profiled.body.diagnostics.server_ms >= 0);
  assert.ok("manifest_read" in profiled.body.diagnostics.stages_ms);
  assert.equal(
    (await call("a", "/search", profileInput, "wrong", { "x-nmg-profile": "1" })).status,
    401,
  );
  assert.ok(!("diagnostics" in (await call("a", "/search", profileInput)).body));
  console.log("PASS: API-key-authorized opt-in query timings; profiling is off by default.");
  // Raw requests deliberately bypass fixture defaults for required-field tests.
  const raw = async (route, body) => {
    const worker = await mf.getWorker("a");
    return worker.fetch("http://localhost" + route, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  const valid = {
    user_id: "validation",
    session_id: "s",
    request_id: "r",
    messages: [{ role: "user", content: "valid" }],
  };
  for (const field of ["request_id", "session_id", "user_id"]) {
    const invalid = { ...valid };
    delete invalid[field];
    assert.equal((await raw("/add", invalid)).status, 400, field);
  }
  for (const role of [undefined, "system", "tool", 12])
    assert.equal(
      (await raw("/add", { ...valid, messages: [{ role, content: "invalid role" }] })).status,
      400,
    );
  for (const top_k of [undefined, 0, 101, "5", 1.5])
    assert.equal(
      (await raw("/search", { user_id: "validation", query: "valid", top_k })).status,
      400,
      "top_k " + top_k,
    );
  const large = {
    user_id: "batch70",
    session_id: "one-session",
    request_id: "batch70",
    messages: Array.from({ length: 70 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      timestamp: 1704067200000,
      content: "Batch probe robot item " + i,
    })),
  };
  const largeResult = await call("a", "/add", large);
  assert.equal(largeResult.status, 200, JSON.stringify(largeResult));
  assert.equal(largeResult.body.added, 70);
  for (let i = 0; i < 32; i++)
    assert.deepEqual(await call(i % 2 ? "a" : "b", "/add", large), largeResult);
  const batchBucket = await mf.getR2Bucket("MEMORY", "a");
  const batchManifest = JSON.parse(
    await (
      await batchBucket.get(
        "users/" +
          createHash("sha256").update("batch70").digest("hex").slice(0, 24) +
          "/manifest.json",
      )
    ).text(),
  );
  const batchImage = Buffer.from(
    await (await batchBucket.get(batchManifest.parts[0].key)).arrayBuffer(),
  );
  const inspected = spawnSync(
    python,
    [
      "-c",
      `import sys,sqlite3,json
c=sqlite3.connect(':memory:');c.deserialize(sys.stdin.buffer.read())
print(json.dumps(c.execute('SELECT count(*),count(DISTINCT source_message_id),count(DISTINCT session_id) FROM history_records').fetchone()))`,
    ],
    { input: batchImage },
  );
  assert.equal(inspected.status, 0, inspected.stderr.toString());
  assert.deepEqual(JSON.parse(inspected.stdout.toString()), [70, 70, 1]);
  console.log(
    "PASS: raw required-field validation returns 400; 70-message Add, 32 idempotent retries, 70 distinct evidence IDs in one original session.",
  );
  const imported = spawnSync(
    python,
    [
      "-c",
      `import sys,sqlite3,json
c=sqlite3.connect(':memory:');c.deserialize(sys.stdin.buffer.read())
r=c.execute('select statement,memory_type,source_actor,truth_status,event_time,scope_json,markers_json,write_source,residence,session_id from memory_records order by rowid').fetchall()
print(json.dumps(r))`,
    ],
    { input: batchImage },
  );
  assert.equal(imported.status, 0, imported.stderr.toString());
  const rows = JSON.parse(imported.stdout.toString());
  assert.equal(rows.length, 70);
  rows.forEach((row, i) => {
    assert.equal(row[0], large.messages[i].content);
    assert.equal(row[1], "event");
    assert.equal(row[2], large.messages[i].role);
    assert.equal(row[3], "asserted");
    assert.equal(row[4], "2024-01-01T00:00:00.000Z");
    assert.deepEqual(JSON.parse(row[5]), { aml_user: "batch70" });
    assert.equal(row[7], "import");
    assert.equal(row[8], "ltg");
    assert.equal(row[9], null);
    assert.ok(
      JSON.parse(row[6]).some(
        (m) => m.kind === "aml_session" && m.attributes.session_id === "one-session",
      ),
    );
  });
  const absent = await call("a", "/search", {
    user_id: "streaming-delta",
    query: "qxvzznotfound",
    top_k: 3,
  });
  assert.deepEqual(absent.body.data, []);
  const choices = await call("a", "/search", {
    user_id: "streaming-delta",
    query: "qxvzznotfound",
    options: ["robot alpha"],
    top_k: 3,
  });
  assert.ok(choices.body.data.length > 0);
  assert.ok(choices.body.data.length <= 3);
  assert.equal(
    (await raw("/search", { user_id: "validation", query: "valid", top_k: 10, options: "wrong" }))
      .status,
    400,
  );
  const longContent = "Long verbatim evidence about the robot Atlas. ".repeat(120).trim();
  const longAdd = await call("a", "/add", {
    user_id: "long-evidence",
    request_id: "long-1",
    messages: [{ role: "assistant", content: longContent }],
  });
  assert.equal(longAdd.status, 200, JSON.stringify(longAdd));
  const longSearch = await call("a", "/search", {
    user_id: "long-evidence",
    query: "robot Atlas",
    top_k: 1,
  });
  assert.equal(longSearch.body.data[0].content, longContent);
  console.log(
    "PASS: daemon import order, actors, timestamps, scope/session provenance, multi-choice union and long verbatim evidence.",
  );

  const input = {
    user_id: "alice",
    session_id: "s1",
    request_id: "r1",
    messages: [
      {
        role: "user",
        timestamp: 1704067200000,
        content: "My favorite robot is Atlas. I study robotics.",
      },
    ],
  };
  const added = await call("a", "/add", input);
  assert.equal(added.status, 200, JSON.stringify(added));
  assert.equal(added.body.added, 1);
  const repeat = await call("b", "/add", input);
  assert.deepEqual(repeat, added);
  assert.equal(
    (await call("a", "/add", { ...input, messages: [{ content: "changed" }] })).status,
    409,
  );
  const found = await call("b", "/search", {
    user_id: "alice",
    query: "favorite robot Atlas",
    top_k: 100,
  });
  assert.equal(found.status, 200, JSON.stringify(found));
  assert.equal(found.body.data.length, 1);
  assert.match(found.body.data[0].content, /Atlas/);
  assert.equal(found.body.data[0].created_at, "2024-01-01T00:00:00.000Z");
  assert.equal(
    (await call("b", "/search", { user_id: "bob", query: "favorite robot Atlas" })).body.data
      .length,
    0,
  );
  // One request may carry independent retrieval clauses. The response fuses them
  // into one pool and reports what each clause put on the page.
  const multi = await call("a", "/search", {
    user_id: "alice",
    queries: [
      { name: "original", text: "favorite robot Atlas" },
      { name: "content", text: "Atlas robotics study" },
    ],
    top_k: 10,
  });
  assert.equal(multi.status, 200, JSON.stringify(multi));
  assert.ok(multi.body.data.length > 0);
  assert.equal(multi.body.timings.clauses, 2);
  assert.equal(multi.body.clauses.length, 2);
  assert.deepEqual(
    multi.body.clauses.map((c) => c.name),
    ["original", "content"],
  );
  for (const clause of multi.body.clauses) {
    assert.ok(Number.isInteger(clause.contributed) && clause.contributed >= 0);
    assert.ok(Number.isInteger(clause.exclusive) && clause.exclusive >= 0);
  }
  assert.ok(
    multi.body.clauses.reduce((sum, c) => sum + c.contributed, 0) >= multi.body.data.length,
    "every returned memory is attributed to at least one clause",
  );
  const plain = await call("a", "/search", {
    user_id: "alice",
    queries: ["favorite robot Atlas", "Atlas robotics study"],
    top_k: 10,
  });
  assert.equal(plain.status, 200, JSON.stringify(plain));
  assert.deepEqual(
    plain.body.clauses.map((c) => c.name),
    [null, null],
  );
  // The legacy single-clause shape keeps its response and gains one clause row.
  const legacy = await call("a", "/search", {
    user_id: "alice",
    query: "favorite robot Atlas",
    top_k: 5,
  });
  assert.equal(legacy.status, 200, JSON.stringify(legacy));
  assert.equal(legacy.body.clauses.length, 1);
  assert.equal(legacy.body.clauses[0].index, 0);
  // Duplicate clause text collapses before retrieval, keeping the first label.
  const deduped = await call("a", "/search", {
    user_id: "alice",
    queries: ["favorite robot Atlas", { name: "dup", text: "favorite robot Atlas" }],
    top_k: 5,
  });
  assert.equal(deduped.status, 200, JSON.stringify(deduped));
  assert.equal(deduped.body.clauses.length, 1);
  assert.equal(deduped.body.clauses[0].name, null);
  // Ambiguous or unbounded clause input is rejected rather than guessed.
  for (const queries of [
    "nope",
    [],
    Array.from({ length: 9 }, (_, i) => "clause " + i),
    [{ name: "no-text" }],
    [["nested"]],
    null,
  ]) {
    assert.equal(
      (await raw("/search", { user_id: "alice", queries })).status,
      400,
      "queries " + JSON.stringify(queries),
    );
  }
  assert.equal(
    (await raw("/search", { user_id: "alice", query: "robot", queries: ["robot"] })).status,
    400,
  );
  assert.equal(
    (await raw("/search", { user_id: "alice", queries: ["robot"], options: ["a"] })).status,
    400,
  );
  assert.equal(
    (await raw("/search", { user_id: "alice", queries: [{ text: "robot", name: "x".repeat(65) }] }))
      .status,
    400,
  );
  console.log(
    "PASS: multi-clause search fuses in one request and reports per-clause contribution.",
  );
  assert.equal((await call("a", "/add/status/" + added.body.task_id)).body.status, "completed");
  // Two independent isolates update the same object; conditional writes must retain both.
  const simultaneous = await Promise.all(
    ["a", "b"].map((name, i) =>
      call(name, "/add", {
        user_id: "alice",
        session_id: "parallel" + i,
        request_id: "parallel" + i,
        messages: [{ content: "Parallel robot memory number " + i }],
      }),
    ),
  );
  for (const r of simultaneous) assert.equal(r.status, 200, JSON.stringify(r));
  await mf.dispose();
  mf = start();
  const restored = await call("a", "/search", { user_id: "alice", query: "robot", top_k: 10 });
  assert.equal(restored.status, 200, JSON.stringify(restored));
  assert.equal(restored.body.data.length, 3);
  const restoredStatus = await call("a", "/add/status/" + added.body.task_id);
  assert.equal(restoredStatus.body.status, "completed");
  const owner = {
    "oai-authenticated-user-email": "owner@example.test",
    origin: "http://localhost",
  };
  const serviceHealth = await call("a", "/health");
  assert.equal(serviceHealth.body.memory_service, "daemon-core-aml-v1");
  assert.equal(serviceHealth.body.harness, false);
  assert.equal(serviceHealth.body.search_profile.persistTrace, false);
  const publicPage = await (await (await mf.getWorker("a")).fetch("http://localhost/")).text();
  assert.match(publicPage, /id="diagnostics" hidden/);
  const ownerPage = await (
    await (await mf.getWorker("a")).fetch("http://localhost/", { headers: owner })
  ).text();
  assert.match(ownerPage, /id="diagnostics" style=/);
  assert.ok(!ownerPage.includes('id="diagnostics" hidden'));
  assert.equal((await call("a", "/admin/status")).status, 401);
  assert.equal(
    (
      await call("a", "/admin/status", undefined, "test-key", {
        "oai-authenticated-user-email": "other@example.test",
      })
    ).status,
    401,
  );
  let overview = await call("a", "/admin/status", undefined, "test-key", owner);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.load.statistics_enabled, false);
  assert.equal(overview.body.load.accepted, 0);
  assert.equal(
    (
      await call("a", "/admin/statistics", { enabled: true }, "test-key", {
        ...owner,
        origin: "http://127.0.0.1",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("a", "/admin/statistics", { enabled: true }, "test-key", owner)).status,
    200,
  );
  await call("a", "/health");
  overview = await call("a", "/admin/status", undefined, "test-key", owner);
  assert.ok(overview.body.load.accepted > 0);
  assert.equal((await call("a", "/admin/diagnostics/seed", {}, "test-key", owner)).status, 200);
  const measured = await call(
    "a",
    "/admin/diagnostics/search",
    { user_id: "__nmg_diagnostics_v1", query: "robot Atlas", repetitions: 2 },
    "test-key",
    owner,
  );
  assert.equal(measured.status, 200, JSON.stringify(measured));
  assert.equal(measured.body.runs.length, 2);
  for (const run of measured.body.runs) {
    assert.equal(run.partitions, 1);
    assert.ok(run.server_ms >= 0);
    assert.ok(!("manifest_commit" in run.stages_ms));
    assert.equal(run.persistence.full_snapshot_saves, 0);
    assert.equal(run.persistence.inline_delta_saves, 0);
    assert.ok(!("partition_save" in run.stages_ms));
    assert.ok(!("sqlite_export" in run.stages_ms), "pure search must not export its SQLite image");
  }
  // Compare both persistence modes from exactly the same database state.
  const bucket = await mf.getR2Bucket("MEMORY", "a");
  const userKey = (id) => createHash("sha256").update(id).digest("hex").slice(0, 24);
  const manifestPath = (id) => "users/" + userKey(id) + "/manifest.json";
  const fixture = await (await bucket.get(manifestPath("__nmg_diagnostics_v1"))).json();
  const baselinePart = fixture.parts[0];
  const restoredImage = applyPageDelta(
    new Uint8Array(await (await bucket.get(baselinePart.key)).arrayBuffer()),
    baselinePart,
  );
  const state = (image) => {
    const r = spawnSync(
      python,
      [
        "-c",
        `import sys,sqlite3,json
+c=sqlite3.connect(':memory:');c.deserialize(sys.stdin.buffer.read())
+print(json.dumps({'records':c.execute('select id,access_count,pending_access_count from memory_records order by id').fetchall(),'traces':c.execute('select count(*) from retrieval_traces').fetchone()[0],'application_id':c.execute('pragma application_id').fetchone()[0]}))`.replace(
          /^\+/gm,
          "",
        ),
      ],
      { input: image },
    );
    assert.equal(r.status, 0, r.stderr.toString());
    return JSON.parse(r.stdout);
  };
  // Simulate an outstanding old page overlay with a SQLite application tag.
  const oldOverlay = Buffer.from(restoredImage);
  oldOverlay.writeUInt32BE(42, 68);
  const beforeState = state(oldOverlay);
  assert.equal(beforeState.application_id, 42);
  const outcomes = {};
  for (const mode of ["delta", "snapshot"]) {
    const uid = "diagnostics-parity-" + mode;
    const key = "users/" + userKey(uid) + "/parts/parity.sqlite";
    await bucket.put(key, restoredImage);
    const clone = structuredClone(fixture);
    clone.parts = [
      makePageDelta(
        { scope: baselinePart.scope, key, bytes: restoredImage.length },
        restoredImage,
        new Uint8Array(oldOverlay),
        1024 * 1024,
      ).part,
    ];
    clone.receipts = {};
    clone.format = "nmg-shards-v3";
    await bucket.put(manifestPath(uid), JSON.stringify(clone));
    const r = await call(
      "a",
      "/admin/diagnostics/search",
      { user_id: uid, query: "robot Atlas", repetitions: 1, persistence: mode },
      "test-key",
      owner,
    );
    assert.equal(r.status, 200, JSON.stringify(r));
    const saved = await (await bucket.get(manifestPath(uid))).json(),
      part = saved.parts[0];
    const image = applyPageDelta(
      new Uint8Array(await (await bucket.get(part.key)).arrayBuffer()),
      part,
    );
    outcomes[mode] = {
      digest: r.body.runs[0].result_digest,
      state: state(image),
      run: r.body.runs[0],
      key: part.key,
    };
    if (mode === "delta") {
      assert.equal(part.key, key);
      assert.equal(saved.format, "nmg-shards-v3");
    } else {
      assert.notEqual(part.key, key);
      assert.equal(saved.format, "nmg-shards-v2");
      assert.ok(!part.delta);
    }
  }
  assert.equal(
    outcomes.delta.digest,
    outcomes.snapshot.digest,
    "Ordered result IDs and scores must match",
  );
  assert.deepEqual(
    outcomes.delta.state,
    outcomes.snapshot.state,
    "Counters and trace count must survive both modes",
  );
  assert.equal(
    outcomes.delta.state.traces,
    beforeState.traces,
    "AML queries must not persist harness traces",
  );
  assert.deepEqual(
    outcomes.delta.state,
    beforeState,
    "Search must preserve old counters and trace state without asserting unobserved use",
  );
  assert.equal(outcomes.delta.run.persistence.full_snapshot_saves, 0);
  assert.equal(outcomes.snapshot.run.persistence.full_snapshot_saves, 1);
  console.log(
    JSON.stringify({
      fixture_records: beforeState.records.length,
      delta_inline_bytes: outcomes.delta.run.persistence.inline_bytes,
      snapshot_bytes: restoredImage.length,
      result_parity: true,
      state_parity: true,
    }),
  );
  // Add folds outstanding overlays into a fresh snapshot, preserving trace state.
  const uid = "diagnostics-parity-delta";
  const parallelSearches = await Promise.all(
    ["a", "b"].map((name) => call(name, "/search", { user_id: uid, query: "robot Atlas" })),
  );
  parallelSearches.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r)));
  const racedManifest = await (await bucket.get(manifestPath(uid))).json(),
    racedPart = racedManifest.parts[0];
  const racedImage = applyPageDelta(
    new Uint8Array(await (await bucket.get(racedPart.key)).arrayBuffer()),
    racedPart,
  );
  const racedState = state(racedImage);
  assert.equal(
    racedState.traces,
    outcomes.delta.state.traces,
    "Concurrent AML searches must not create harness traces",
  );
  assert.deepEqual(
    racedState,
    outcomes.delta.state,
    "Concurrent read-only searches must preserve existing state",
  );
  const inserted = await call("b", "/add", {
    user_id: uid,
    request_id: "after-delta",
    messages: [{ content: "Additional memory after page overlay." }],
  });
  assert.equal(inserted.status, 200);
  const compacted = await (await bucket.get(manifestPath(uid))).json();
  assert.ok(!compacted.parts[0].delta);
  const compactImage = new Uint8Array(
    await (await bucket.get(compacted.parts[0].key)).arrayBuffer(),
  );
  assert.equal(state(compactImage).traces, racedState.traces);
  await mf.dispose();
  mf = start();
  assert.equal(
    (await call("a", "/search", { user_id: "diagnostics-parity-snapshot", query: "robot Atlas" }))
      .status,
    200,
  );
  assert.equal((await call("b", "/search", { user_id: uid, query: "robot Atlas" })).status, 200);
  console.log(
    "PASS: snapshot/delta ordered result and state parity, read-only searches, existing delta preservation, Add compaction, cold restart.",
  );
  assert.equal(
    (
      await call(
        "a",
        "/admin/diagnostics/search",
        { user_id: "alice", query: "robot", repetitions: 11 },
        "test-key",
        owner,
      )
    ).status,
    400,
  );
  await call("a", "/admin/statistics", { enabled: false }, "test-key", owner);
  await call("a", "/health");
  overview = await call("a", "/admin/status", undefined, "test-key", owner);
  assert.equal(overview.body.load.statistics_enabled, false);
  assert.equal(overview.body.load.accepted, 0);
  assert.equal((await call("a", "/diagnostics/self-test", { op: "seed" })).status, 401);
  assert.equal(
    (await call("b", "/diagnostics/self-test", { op: "seed" }, "self-test-key")).status,
    401,
  );
  assert.equal(
    (await call("a", "/diagnostics/self-test", { op: "query", user_id: "alice" }, "self-test-key"))
      .status,
    400,
  );
  assert.equal(
    (await call("a", "/search", { user_id: "alice", query: "robot" }, "self-test-key")).status,
    401,
  );
  assert.equal(
    (await call("a", "/diagnostics/self-test", { op: "seed" }, "self-test-key")).status,
    200,
  );
  const selfMeasured = await call(
    "a",
    "/diagnostics/self-test",
    { op: "query", repetitions: 1 },
    "self-test-key",
  );
  assert.equal(selfMeasured.status, 200, JSON.stringify(selfMeasured));
  assert.ok(selfMeasured.body.runs[0].result_count > 0);
  const contract = await call("a", "/diagnostics/self-test", { op: "contract" }, "self-test-key");
  assert.equal(contract.status, 200, JSON.stringify(contract));
  assert.equal(contract.body.success, true);
  assert.equal(contract.body.checks.length, 12);

  const capacityBucket = await mf.getR2Bucket("MEMORY", "a");
  assert.equal((await call("a", "/capacity?user_id=alice", undefined, "wrong")).status, 401);
  assert.equal((await call("a", "/admin/capacity?user_id=alice")).status, 401);
  assert.equal((await call("a", "/capacity")).status, 400);
  const emptyCapacity = await call("a", "/capacity?user_id=capacity-empty");
  assert.equal(emptyCapacity.status, 200);
  assert.equal(emptyCapacity.body.exists, false);
  assert.equal(emptyCapacity.body.sqlite_bytes.used, 0);
  assert.equal(emptyCapacity.body.add_requests.remaining, 16384);
  const etagBefore = (await capacityBucket.head(manifestPath("batch70"))).etag;
  const capacity = await call("a", "/capacity?user_id=batch70");
  assert.equal(capacity.status, 200);
  assert.equal(capacity.body.partitions.used, batchManifest.parts.length);
  assert.equal(
    capacity.body.sqlite_bytes.used,
    batchManifest.parts.reduce((n, p) => n + p.bytes, 0),
  );
  assert.equal(capacity.body.add_requests.used, 1);
  assert.equal(capacity.body.add_requests.remaining, 16383);
  assert.equal(
    (await capacityBucket.head(manifestPath("batch70"))).etag,
    etagBefore,
    "Capacity reads must not write the manifest",
  );
  const adminCapacity = await call(
    "a",
    "/admin/capacity?user_id=batch70",
    undefined,
    "wrong",
    owner,
  );
  assert.equal(adminCapacity.status, 200);
  assert.equal(adminCapacity.body.sqlite_bytes.used, capacity.body.sqlite_bytes.used);
  // Deliberately missing shard objects: reading capacity must not fetch/open them.
  const fake = {
    format: "nmg-shards-v3",
    parts: Array.from({ length: 128 }, (_, i) => ({
      scope: "quota-" + i,
      key: "missing/" + i,
      bytes: 6 * 1024 * 1024,
    })),
    receipts: Object.fromEntries(Array.from({ length: 16384 }, (_, i) => ["r" + i, {}])),
  };
  fake.parts[0].delta = { page_size: 8192, pages: { 0: "metadata-only" } };
  await capacityBucket.put(manifestPath("capacity-full"), JSON.stringify(fake));
  const full = await call("a", "/api/capacity?user_id=capacity-full");
  assert.equal(full.status, 200, JSON.stringify(full));
  assert.equal(full.body.partitions.remaining, 0);
  assert.equal(full.body.add_requests.remaining, 0);
  assert.equal(full.body.inline_delta_bytes, 8192);
  assert.ok(
    full.body.warnings.some((w) => w.resource === "add_requests" && w.level === "limit_reached"),
  );
  assert.equal(full.body.sqlite_bytes.used, 128 * 6 * 1024 * 1024);
  fake.parts = fake.parts.slice(0, 103);
  fake.receipts = Object.fromEntries(Object.entries(fake.receipts).slice(0, 13108));
  await capacityBucket.put(manifestPath("capacity-near"), JSON.stringify(fake));
  const near = await call("a", "/capacity?user_id=capacity-near");
  assert.equal(near.status, 200);
  assert.ok(
    near.body.warnings.some((w) => w.resource === "partitions" && w.level === "near_limit"),
  );
  assert.ok(
    near.body.warnings.some((w) => w.resource === "add_requests" && w.level === "near_limit"),
  );
  const legacyId = "capacity-legacy";
  await capacityBucket.put("users/" + userKey(legacyId) + ".sqlite", new Uint8Array(4096));
  const legacyCapacity = await call("a", "/capacity?user_id=" + legacyId);
  assert.equal(legacyCapacity.status, 200);
  assert.equal(legacyCapacity.body.source, "legacy_object_head");
  assert.equal(legacyCapacity.body.sqlite_bytes.used, 4096);
  assert.equal(legacyCapacity.body.add_requests.used, null);
  console.log(
    "PASS: authenticated/owner capacity reads, no shard access or writes, empty/legacy/overlay state, exact byte and receipt quotas, warning thresholds.",
  );
  console.log(
    "PASS: self-test credential scope, expiry, fixed fixture, bounded contract probe, direct server diagnostics.",
  );
  console.log(
    "PASS: diagnostics owner authorization, same-origin writes, default-off statistics, bounded runs, commit-inclusive timings, statistics toggle.",
  );
  console.log(
    "PASS: auth, validation, daemon-core search, user isolation, idempotency, write status, cross-isolate concurrent writes, cold restart persistence.",
  );
} finally {
  await mf.dispose();
}
