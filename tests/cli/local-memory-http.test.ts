import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

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
