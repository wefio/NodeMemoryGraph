/**
 * Chaos 2 — daemon server-side fault injection via @mizchi/server-faults.
 *
 * The real NmgService + real node:http stack + real client (connectDaemon /
 * invokeDaemon) run in-process; a server-faults layer sits in front of the
 * httpHandler and is switched per scenario (deterministic: rate=1 with a
 * fixed seed). Validates:
 *   - 5xx → plain Error (no reconnect, correct propagation)
 *   - latency → call completes, never hangs
 *   - abort hangup/reset → fetch TypeError → invokeDaemon auto-reconnect path
 *   - recovery: after each fault the same server serves normal calls again
 *   - no-leak: server close never stalls even with faulted sockets in flight
 *     (the keep-alive teardown incident, reproduced as a chaos scenario)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serverFaults, type FaultVerdict, type ServerFaultHandle } from "@mizchi/server-faults";

import { NmgService } from "../../src/cli/service.ts";
import { httpHandler } from "../../src/cli/http-server.ts";
import { connectDaemon, invokeDaemon, type DaemonConnection } from "../../src/cli/daemon-client.ts";
import { serverStatePath } from "../../src/cli/lifecycle.ts";

const TOKEN = "chaos-token";

function toRequest(req: IncomingMessage): Request {
  // Do NOT consume the request stream — the base handler reads it itself.
  // server-faults only inspects url/method/headers; body stays on the wire.
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, {
    method: req.method ?? "POST",
    headers: req.headers as Record<string, string>,
  });
}

async function writeVerdict(res: ServerResponse, verdict: FaultVerdict): Promise<void> {
  if (verdict === null) return;
  switch (verdict.kind) {
    case "synthetic": {
      res.writeHead(verdict.response.status, Object.fromEntries(verdict.response.headers));
      res.end(Buffer.from(await verdict.response.arrayBuffer()));
      return;
    }
    case "abort": {
      if (verdict.abortStyle === "reset") {
        res.socket?.destroy(new Error("chaos reset"));
      } else {
        res.socket?.end();
      }
      return;
    }
    default:
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"chaos unsupported verdict"}');
  }
}

interface ChaosHarness {
  conn: DaemonConnection;
  service: NmgService;
  server: ReturnType<typeof createServer>;
  setFault: (f: ServerFaultHandle | undefined) => void;
  close: () => Promise<void>;
}

async function startChaosHarness(): Promise<ChaosHarness> {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-chaos2-"));
  mkdirSync(directory, { recursive: true });
  const service = new NmgService({ dataDirectory: directory });
  const base = httpHandler(service, TOKEN);
  let fault: ServerFaultHandle | undefined;
  const server = createServer((req, res) => {
    if (fault) {
      void fault.maybeInject(toRequest(req)).then((verdict) => {
        // "annotate" means the perturbation (e.g. latency) already happened;
        // the real handler must still run. Everything else short-circuits.
        if (verdict && verdict.kind !== "annotate") {
          void writeVerdict(res, verdict);
          return;
        }
        base(req, res);
      });
      return;
    }
    base(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const databasePath = join(directory, "nmg.sqlite");
  writeFileSync(
    serverStatePath(databasePath),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      transport: "http",
      host: "127.0.0.1",
      port: address.port,
      token: TOKEN,
    }),
  );
  const conn = await connectDaemon(databasePath);
  return {
    conn,
    service,
    server,
    setFault: (f) => {
      fault = f;
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const off = () => serverFaults({ seed: 1 });
const inject = (cfg: Parameters<typeof serverFaults>[0]) => serverFaults({ seed: 1, ...cfg });

test("chaos baseline: normal calls work through the fault layer", async () => {
  const h = await startChaosHarness();
  try {
    h.setFault(off());
    await invokeDaemon(h.conn, "remember", {
      statement: "chaos baseline",
      nodeName: "chaos-baseline",
    });
    const r = (await invokeDaemon(h.conn, "search", { query: "chaos baseline" })) as {
      results?: unknown[];
    };
    assert.ok((r.results ?? []).length > 0);
  } finally {
    await h.close();
  }
});

test("chaos 5xx: plain Error propagates, no reconnect, service recovers", async () => {
  const h = await startChaosHarness();
  try {
    h.setFault(inject({ status5xxRate: 1, status5xxCode: 503 }));
    await assert.rejects(invokeDaemon(h.conn, "search", { query: "x" }), (e: Error) => {
      assert.equal(e.constructor, Error, "5xx must surface as a plain Error, not a network TypeError");
      assert.match(e.message, /503/);
      return true;
    });
    h.setFault(off());
    const r = (await invokeDaemon(h.conn, "search", { query: "recovered" })) as { results?: unknown[] };
    assert.ok(Array.isArray(r.results), "same server serves normal calls after the fault window");
  } finally {
    await h.close();
  }
});

test("chaos latency: call completes after the injected delay, never hangs", async () => {
  const h = await startChaosHarness();
  try {
    h.setFault(inject({ latencyRate: 1, latencyMs: 600 }));
    const started = Date.now();
    await invokeDaemon(h.conn, "hello");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 500, `expected >=500ms injected latency, got ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `call must complete, got ${elapsed}ms`);
  } finally {
    await h.close();
  }
});

test("chaos abort hangup: TypeError drives reconnect, then recovery succeeds", async () => {
  const h = await startChaosHarness();
  try {
    h.setFault(inject({ abortRate: 1, abortStyle: "hangup" }));
    // First call hits the abort; the client sees a network TypeError.
    await assert.rejects(invokeDaemon(h.conn, "search", { query: "x" }), (e: Error) => {
      assert.equal(e.constructor, TypeError, "abort must surface as a network TypeError");
      return true;
    });
    // Recovery: fault window over, same connection serves again.
    h.setFault(off());
    const r = (await invokeDaemon(h.conn, "search", { query: "after abort" })) as { results?: unknown[] };
    assert.ok(Array.isArray(r.results));
  } finally {
    await h.close();
  }
});

test("chaos abort reset: ECONNRESET surfaces as TypeError, recovers", async () => {
  const h = await startChaosHarness();
  try {
    h.setFault(inject({ abortRate: 1, abortStyle: "reset" }));
    await assert.rejects(invokeDaemon(h.conn, "search", { query: "x" }), (e: Error) => {
      assert.equal(e.constructor, TypeError, "ECONNRESET must surface as a network TypeError");
      return true;
    });
    h.setFault(off());
    const r = (await invokeDaemon(h.conn, "search", { query: "after reset" })) as { results?: unknown[] };
    assert.ok(Array.isArray(r.results));
  } finally {
    await h.close();
  }
});

test("chaos no-leak: server close never stalls with faulted sockets in flight", async () => {
  const h = await startChaosHarness();
  try {
    // Fire a faulted call and tear down while the connection is in a broken
    // state — the keep-alive teardown incident, as a chaos scenario.
    h.setFault(inject({ abortRate: 1, abortStyle: "reset" }));
    await invokeDaemon(h.conn, "search", { query: "x" }).catch(() => undefined);
    h.setFault(off());
    await invokeDaemon(h.conn, "remember", {
      statement: "leak probe",
      nodeName: "leak-probe",
    });
    // close must resolve promptly; a leak would stall here forever.
    const closed = await Promise.race([
      new Promise<boolean>((r) => {
        h.server.close(() => r(true));
        h.service.close();
      }),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
    ]);
    assert.equal(closed, true, "server.close must resolve after chaos-induced faults");
  } finally {
    rmSync(resolve(tmpdir(), "nmg-chaos2-"), { recursive: true, force: true });
  }
});
