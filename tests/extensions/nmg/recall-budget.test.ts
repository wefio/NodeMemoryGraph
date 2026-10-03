import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import nmgExtension from "../../../.pi/extensions/nmg/index.ts";
import { acquireServerLease } from "../../../src/cli/lifecycle.ts";
import { NMG_PROTOCOL_VERSION } from "../../../src/cli/protocol.ts";
import { NmgStore } from "../../../src/core/store.ts";
import { decideMemoryLoad } from "../../../src/core/gate.ts";

type HookResult = {
  message?: {
    content: string;
    details?: {
      recallTiming?: { expired: boolean; stages: Array<{ phase: string; outcome: string }> };
    };
  };
};

function assertTimedOutPhase(result: HookResult, phase: string): void {
  const timing = result.message?.details?.recallTiming;
  assert.equal(timing?.expired, true);
  assert.ok(
    timing?.stages.some((stage) => stage.phase === phase && stage.outcome === "timeout"),
    "the interrupted phase is recorded without prompt content",
  );
}

for (const delayed of ["hello", "search", "disclosure"] as const) {
  test(
    `automatic recall stops at five seconds during ${delayed} and keeps only timely results`,
    { timeout: 10_000 },
    async (t) => {
      const prompt = "What did we previously decide about Atlas SQLite offline storage?";
      assert.equal(
        decideMemoryLoad(prompt).mode,
        "retrieve",
        "the fixture must actually enter automatic recall",
      );
      const directory = mkdtempSync(join(tmpdir(), "nmg-recall-budget-"));
      const priorData = process.env.NMG_DATA_DIR;
      const priorLab = process.env.NMG_ENABLE_LAB_TOOLS;
      process.env.NMG_DATA_DIR = directory;
      process.env.NMG_ENABLE_LAB_TOOLS = "0";
      const lease = acquireServerLease(join(directory, "nmg.sqlite"));
      lease.update({
        transport: "http",
        host: "127.0.0.1",
        port: 12345,
        token: "budget-test-not-a-secret",
      });
      const store = new NmgStore(":memory:");
      const memory = store.remember({
        statement: "Atlas uses SQLite for offline storage",
        nodeName: "Atlas storage",
      }).memory;
      const context = store.searchContext("Atlas SQLite offline storage", { maxTier: 1, limit: 1 });
      store.close();
      let reached!: () => void;
      const atDelay = new Promise<void>((resolve) => {
        reached = resolve;
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          method: string;
          params: { action?: string };
        };
        let result: unknown = {};
        if (request.method === "hello")
          result = {
            protocol: NMG_PROTOCOL_VERSION,
            service: "node-memory-graph",
            version: "test",
            capabilities: ["session-active-graph"],
          };
        if (request.method === "search") result = context;
        if (request.method === "sessionActiveGraph" && request.params.action === "disclose")
          result = { freshMemoryIds: [memory.id], foldedMemoryIds: [] };
        if (
          (delayed === "hello" && request.method === "hello") ||
          (delayed === "search" && request.method === "search") ||
          (delayed === "disclosure" && request.params.action === "disclose")
        ) {
          reached();
          await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      });
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<HookResult>>();
      nmgExtension({
        on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<HookResult>) =>
          handlers.set(name, handler),
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
      } as never);
      let settled = false;
      const pending = handlers.get("before_agent_start")!(
        { prompt, systemPrompt: "base" },
        {
          sessionManager: {
            getSessionId: () => "budget-session",
            getSessionFile: () => "budget.jsonl",
          },
        },
      ).then((result) => {
        settled = true;
        return result;
      });
      try {
        await Promise.race([
          atDelay,
          pending.then(() => {
            throw new Error("the hook returned without entering the delayed phase");
          }),
        ]);
        t.mock.timers.tick(5_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          settled,
          true,
          "a slow daemon phase must not hold up the user turn past the total budget",
        );
        const result = await pending;
        if (delayed === "disclosure")
          assert.match(result.message?.content ?? "", new RegExp(memory.id));
        else assert.doesNotMatch(result.message?.content ?? "", new RegExp(memory.id));
        assertTimedOutPhase(result, delayed === "hello" ? "connection" : delayed);
        const before = result.message?.content;
        t.mock.timers.tick(6_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          result.message?.content,
          before,
          "a late search/disclosure cannot alter returned context",
        );
      } finally {
        t.mock.timers.tick(6_000);
        await pending;
        lease.release();
        if (priorData === undefined) delete process.env.NMG_DATA_DIR;
        else process.env.NMG_DATA_DIR = priorData;
        if (priorLab === undefined) delete process.env.NMG_ENABLE_LAB_TOOLS;
        else process.env.NMG_ENABLE_LAB_TOOLS = priorLab;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
