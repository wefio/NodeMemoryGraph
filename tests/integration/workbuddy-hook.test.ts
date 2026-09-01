import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MemoryContext } from "../../src/core/types.ts";
import { liveLease, runHook } from "../../workbuddy-plugin/nmg-hook.ts";

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

function searchContext(): MemoryContext {
  return {
    results: [
      {
        memory: {
          id: "memory-atlas",
          statement: "Atlas uses SQLite offline.",
          memoryType: "constraint",
          resolution: "resolved",
          markers: [],
          eventTime: null,
          expiresAt: null,
          validUntil: null,
        },
        node: { canonicalName: "Atlas storage" },
        chainMemberships: [
          {
            chainId: "chain-atlas",
            chainType: "logical",
            topic: "Atlas portability",
          },
        ],
      },
    ],
    activeGraph: { id: "projection-hook" },
    progressiveDisclosure: { deferredMemoryIds: [] },
  } as unknown as MemoryContext;
}

function jsonRpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("WorkBuddy recall verifies v9 and uses the daemon-owned session disclosure ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-workbuddy-hook-"));
  writeLease(directory);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    calls.push(body);
    if (body.method === "hello") {
      return jsonRpc({
        protocol: "nmg.v9",
        service: "node-memory-graph",
        version: "test",
        capabilities: ["session-active-graph"],
      });
    }
    if (body.method === "search") return jsonRpc(searchContext());
    if (body.method === "sessionActiveGraph") {
      if (body.params.action === "beginDisclosureTurn") {
        return jsonRpc({ action: "beginDisclosureTurn", turn: 1 });
      }
      if (body.params.action === "disclose") {
        return jsonRpc({
          action: "disclose",
          freshMemoryIds: ["memory-atlas"],
          foldedMemoryIds: [],
        });
      }
    }
    throw new Error(`unexpected RPC ${body.method}`);
  }) as typeof fetch;
  try {
    const output = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "workbuddy-session",
        cwd: "C:/workspace/atlas",
        prompt: "Which database does Atlas use offline?",
      },
      { dir: directory, environment: { NMG_ENABLE_COORDINATION: "0" } },
    );
    assert.match(output, /Atlas uses SQLite offline/u);
    assert.match(output, /call nmg_search through/u);
    assert.match(output, /activeGraphId=/u);
    assert.match(output, /logical_chains=1/u);
    assert.equal(calls.filter((call) => call.method === "hello").length, 1);
    assert.equal(calls.filter((call) => call.method === "taskBoard").length, 0);
    const search = calls.find((call) => call.method === "search")!;
    assert.equal(search.params.projectDir, "C:/workspace/atlas");
    assert.equal(search.params.sessionId, "workbuddy-hook:workbuddy-session");
    const agCalls = calls.filter((call) => call.method === "sessionActiveGraph");
    assert.deepEqual(
      agCalls.map((call) => call.params.action),
      ["beginDisclosureTurn", "disclose"],
    );
    assert.ok(agCalls.every((call) => call.params.sessionId === search.params.sessionId));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("WorkBuddy hook rejects incompatible and non-loopback leases before recall", async () => {
  const incompatible = mkdtempSync(join(tmpdir(), "nmg-workbuddy-v8-"));
  const nonLoopback = mkdtempSync(join(tmpdir(), "nmg-workbuddy-host-"));
  writeLease(incompatible);
  writeLease(nonLoopback, { host: "example.com" });
  assert.equal(liveLease(nonLoopback), null);
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    methods.push(body.method);
    return jsonRpc({
      protocol: "nmg.v8",
      service: "node-memory-graph",
      version: "old",
      capabilities: [],
    });
  }) as typeof fetch;
  try {
    const output = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "recall this" },
      { dir: incompatible, environment: { NMG_ENABLE_COORDINATION: "0" } },
    );
    assert.equal(output, "");
    assert.deepEqual(methods, ["hello"]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(incompatible, { recursive: true, force: true });
    rmSync(nonLoopback, { recursive: true, force: true });
  }
});
