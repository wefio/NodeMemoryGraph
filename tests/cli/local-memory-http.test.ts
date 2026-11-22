import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalBackendPool } from "../../src/cli/local-memory-http.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

const cli = resolve(import.meta.dirname, "../../src/cli/main.ts");
const apiKey = "fixture-http-key";

async function startHttp(configPath: string) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", cli, "http", "--config", configPath],
    {
      env: { ...process.env, NMG_TEST_LOCAL_HTTP_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const exited = once(child, "exit");
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (data: string) => (errors += data));
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
  try {
    const [line] = await Promise.race([
      once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) }),
      exited.then(() => {
        throw new Error(`HTTP listener exited before startup: ${errors}`);
      }),
    ]);
    const endpoint = /NMG HTTP listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(String(line))?.[1];
    assert.ok(endpoint, String(line));
    return { endpoint, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function post(endpoint: string, path: string, body: object, key = apiKey) {
  return fetch(endpoint + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

test(
  "local memory HTTP command uses configured SQLite and returns the NMG search rendering",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "nmg-local-http-"));
    const configPath = join(dir, "http.json");
    await writeFile(
      configPath,
      JSON.stringify({
        port: 0,
        databasePath: "memory.sqlite",
        apiKeyEnv: "NMG_TEST_LOCAL_HTTP_KEY",
        defaultTopK: 1,
        maxRequestBytes: 1000,
      }),
    );
    const input = {
      user_id: "alice",
      session_id: "winter-notes",
      request_id: "message-one",
      messages: [
        {
          role: "user",
          content: "The frosted skylark nests in a ceramic lantern.",
          timestamp: 1700000000000,
        },
      ],
    };
    const query = { user_id: "alice", query: "frosted skylark" };
    async function assertStored(endpoint: string) {
      const response = await post(endpoint, "/search", query);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.data.length, 1);
      assert.match(result.data[0].content, /ceramic lantern/u);
      assert.match(result.rendered, /ceramic lantern/u);
      assert.match(result.rendered, /^- \[event\]/mu);
      assert.doesNotMatch(result.rendered, /nmg_get/u);
    }
    try {
      const active = await startHttp(configPath);
      try {
        const health = await fetch(active.endpoint + "/health", {
          signal: AbortSignal.timeout(5000),
        });
        assert.deepEqual(await health.json(), { status: "ok", storage: "sqlite" });
        assert.equal((await fetch(active.endpoint + "/capacity")).status, 404);
        assert.equal((await post(active.endpoint, "/remember", input)).status, 404);
        assert.equal((await post(active.endpoint, "/add", input, "wrong")).status, 401);
        assert.equal(
          (await post(active.endpoint, "/add", { ...input, padding: "x".repeat(1000) })).status,
          413,
        );
        const chunked: RequestInit & { duplex: "half" } = {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          duplex: "half",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(1200) })),
              );
              controller.close();
            },
          }),
          signal: AbortSignal.timeout(5000),
        };
        assert.equal((await fetch(active.endpoint + "/add", chunked)).status, 413);
        const [added, repeated] = await Promise.all([
          post(active.endpoint, "/add", input),
          post(active.endpoint, "/add", input),
        ]);
        assert.equal(added.status, 200);
        assert.equal(repeated.status, 200);
        const receipt = await added.json();
        assert.equal(receipt.status, "completed");
        assert.equal(receipt.added, 1);
        assert.deepEqual(await repeated.json(), receipt);
        const conflict = await post(active.endpoint, "/add", {
          ...input,
          session_id: "another-session",
        });
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json()).error.code, "request_id_reused");
        assert.deepEqual(
          (await (await post(active.endpoint, "/search", { ...query, user_id: "bob" })).json())
            .data,
          [],
        );
        const withOptions = await post(active.endpoint, "/search", {
          ...query,
          options: ["ceramic lantern", "stone bench"],
        });
        assert.equal(withOptions.status, 200);
        const optionsBody = await withOptions.json();
        assert.ok(Array.isArray(optionsBody.data) && optionsBody.data.length === 1);
        const withNow = await post(active.endpoint, "/search", {
          ...query,
          now: "2023-11-15T08:00:00+08:00",
        });
        assert.equal(withNow.status, 200);
        assert.equal(
          (await post(active.endpoint, "/search", { ...query, now: "not-a-timestamp" })).status,
          400,
        );
        await assertStored(active.endpoint);
      } finally {
        await active.stop();
      }
      const restarted = await startHttp(configPath);
      try {
        await assertStored(restarted.endpoint);
      } finally {
        await restarted.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("LocalBackendPool reuses backends per namespace, isolates users, and defers LRU eviction while active", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nmg-local-http-pool-"));
  const pool = new LocalBackendPool(join(dir, "pool.sqlite"), 2);
  t.after(async () => {
    await pool.closeAll();
    removeTempDirectory(dir);
  });

  // Sequential & concurrent calls on the same namespace reuse one backend instance.
  const first = await pool.withBackend("http:u1", async (backend) => backend);
  const second = await pool.withBackend("http:u1", async (backend) => backend);
  assert.equal(first, second);
  const [c1, c2] = await Promise.all([
    pool.withBackend("http:u1", async (backend) => {
      await new MemoryEngine(backend).remember({
        statement: "User one secret note",
        nodeName: "U1",
      });
      return backend;
    }),
    pool.withBackend("http:u1", async (backend) => backend),
  ]);
  assert.equal(c1, first);
  assert.equal(c2, first);

  // Distinct namespaces get separate handles and isolated data.
  const u2Backend = await pool.withBackend("http:u2", async (backend) => {
    const hits = await new MemoryEngine(backend).search("User one secret note");
    assert.equal(hits.results.length, 0);
    return backend;
  });
  assert.notEqual(u2Backend, first);

  // In-flight LRU eviction keeps active backend usable until its call completes, then closes it.
  let releaseInFlight!: () => void;
  let inFlight!: Promise<void>;
  const inFlightEntered = new Promise<void>((resolveReady) => {
    inFlight = pool.withBackend("http:u2", async (backend) => {
      assert.equal(backend, u2Backend);
      resolveReady();
      await new Promise<void>((done) => {
        releaseInFlight = done;
      });
      // Still open and usable even though evicted from the pool mid-flight.
      const view = await backend.openRead();
      await backend.closeRead(view);
    });
  });
  await inFlightEntered;

  try {
    // Refresh http:u1 so http:u2 is oldest, then open http:u3 to evict http:u2.
    assert.equal(await pool.withBackend("http:u1", async (backend) => backend), first);
    const u3Backend = await pool.withBackend("http:u3", async (backend) => backend);
    assert.notEqual(u3Backend, u2Backend);
    assert.notEqual(u3Backend, first);
  } finally {
    // Finish the evicted in-flight call and wait for its deferred close before reopening.
    releaseInFlight();
    await inFlight;
  }

  // Subsequent acquisition of http:u2 opens a fresh backend handle (evicting u1 as idle oldest).
  const reopenedU2 = await pool.withBackend("http:u2", async (backend) => backend);
  assert.notEqual(reopenedU2, u2Backend);
});
