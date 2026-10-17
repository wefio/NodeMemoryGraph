import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RPC_TIMEOUT_MS,
  compatibleLease,
  dropCompatibleLease,
  liveLease,
  rpcCall,
} from "../../src/integration/lease-transport.ts";

function writeLease(directory: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "nmg.sqlite.server.json"),
    JSON.stringify({
      transport: "http",
      host: "127.0.0.1",
      port: 28_926,
      token: "0123456789abcdef0123456789abcdef",
      pid: process.pid,
      protocol: "nmg.v9",
      ...overrides,
    }),
  );
}

function jsonRpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Spawn a node process that exits immediately and reuse its (now dead) pid. */
function deadNodePid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  return result.pid ?? 0;
}

/** Real loopback server so rpcCall exercises actual transport errors. */
function startRpcServer(
  handle: (method: string) => { status?: number; result?: unknown; error?: string },
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const method = (JSON.parse(body || "{}") as { method?: string }).method ?? "";
        const answered = handle(method);
        response.writeHead(answered.status ?? 200, {
          "content-type": "application/json",
        });
        const payload = answered.error
          ? { jsonrpc: "2.0", id: 1, error: { message: answered.error } }
          : { jsonrpc: "2.0", id: 1, result: answered.result };
        response.end(JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}

test("liveLease validates shape, loopback, token, and a live pid", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-lease-valid-"));
  try {
    writeLease(directory);
    const lease = liveLease(directory);
    assert.ok(lease);
    assert.equal(lease.host, "127.0.0.1");

    writeLease(directory, { token: "short" });
    assert.equal(liveLease(directory), null);

    writeLease(directory, { host: "example.com" });
    assert.equal(liveLease(directory), null);

    writeLease(directory, { pid: 1, port: 70_000 });
    assert.equal(liveLease(directory), null);

    // A pid from a node process that already exited is not alive.
    writeLease(directory, { pid: deadNodePid() });
    assert.equal(liveLease(directory), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rpcCall maps HTTP, protocol, and daemon errors onto thrown errors", async () => {
  const { port, close } = await startRpcServer((method) => {
    if (method === "hello") return { result: { protocol: "nmg.v9" } };
    if (method === "boom") return { status: 500 };
    if (method === "refused") return { error: "not allowed" };
    return { result: {} };
  });
  const lease = { host: "127.0.0.1", port, token: "t".repeat(32), pid: process.pid };
  try {
    assert.equal(RPC_TIMEOUT_MS, 2_000);
    assert.ok(await rpcCall(lease, "hello", {}));
    await assert.rejects(rpcCall(lease, "boom", {}), /NMG HTTP 500/u);
    await assert.rejects(rpcCall(lease, "refused", {}), /not allowed/u);
  } finally {
    await close();
  }
});

test("compatibleLease handshakes once per directory and re-handshakes after drops", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-lease-cache-"));
  try {
    writeLease(directory);
    // A directory without a lease file never touches the network and is not
    // cached, so a daemon that starts later is still picked up.
    assert.equal(await compatibleLease(join(directory, "empty")), null);

    const originalFetch = globalThis.fetch;
    let helloCalls = 0;
    let helloUp = true;
    globalThis.fetch = (async () => {
      helloCalls += 1;
      if (!helloUp) throw new Error("connection refused");
      return jsonRpc({
        protocol: "nmg.v9",
        service: "node-memory-graph",
        version: "test",
        capabilities: ["session-active-graph"],
      });
    }) as typeof fetch;
    try {
      assert.ok(await compatibleLease(directory));
      // The verified lease is cached: no second hello.
      assert.ok(await compatibleLease(directory));
      assert.equal(helloCalls, 1);

      // A failed handshake is not cached as permanent either: repairing the
      // network lets the next call verify again (daemon may rotate keys).
      dropCompatibleLease(directory);
      helloUp = false;
      assert.equal(await compatibleLease(directory), null);
      helloUp = true;
      const repaired = await compatibleLease(directory);
      assert.ok(repaired);
      assert.equal(helloCalls, 3);

      // Dropping again when the lease is fine re-performs the handshake.
      dropCompatibleLease(directory);
      assert.ok(await compatibleLease(directory));
      assert.equal(helloCalls, 4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compatibleLease rejects leases without the session-active-graph capability", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-lease-cap-"));
  try {
    writeLease(directory);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonRpc({
        protocol: "nmg.v9",
        service: "node-memory-graph",
        version: "test",
        capabilities: [],
      })) as typeof fetch;
    try {
      assert.equal(await compatibleLease(directory), null);
      assert.equal(await compatibleLease(directory), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
