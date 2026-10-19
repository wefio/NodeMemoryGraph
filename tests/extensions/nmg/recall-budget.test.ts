import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import nmgExtension from "../../../.pi/extensions/nmg/index.ts";
import { ControllerShadowBridge } from "../../../.pi/extensions/nmg/controller-shadow.ts";
import { acquireServerLease } from "../../../src/cli/lifecycle.ts";
import { NMG_PROTOCOL_VERSION } from "../../../src/cli/protocol.ts";
import { SessionActiveGraphRuntime } from "../../../src/core/session-active-graph.ts";
import { NmgStore } from "../../../src/core/store.ts";
import { decideMemoryLoad } from "../../../src/core/gate.ts";

type HookResult = {
  message?: {
    content: string;
    details?: {
      recallTiming?: {
        expired: boolean;
        stages: Array<{ phase: string; outcome: string }>;
      };
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

for (const delayed of ["hello", "state", "search", "telemetry"] as const) {
  test(
    `automatic recall stops at five seconds during ${delayed} and keeps only timely typed items`,
    { timeout: 10_000 },
    async (t) => {
      const prompt = "What did we previously decide about Atlas SQLite offline storage?";
      assert.equal(decideMemoryLoad(prompt).mode, "retrieve");
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
      const context = store.searchContext("Atlas SQLite offline storage", {
        maxTier: 1,
        limit: 1,
      });
      store.close();
      const runtime = new SessionActiveGraphRuntime();
      runtime.replaceWorkingState(
        runtime.bindWorkingState("budget-session"),
        "Retain this state through optional recall work.",
      );
      let reached!: () => void;
      const atDelay = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const seenRequests: string[] = [];
      t.mock.timers.enable({ apis: ["setTimeout"] });
      if (delayed === "telemetry") {
        t.mock.method(ControllerShadowBridge.prototype, "retrieval", async () => {
          reached();
          await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
        });
      }
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          method: string;
          params: { action?: string };
        };
        seenRequests.push(`${request.method}:${request.params.action ?? ""}`);
        let result: unknown = {};
        if (request.method === "hello")
          result = {
            protocol: NMG_PROTOCOL_VERSION,
            service: "node-memory-graph",
            version: "test",
            capabilities: ["session-active-graph", "state-spaces"],
          };
        if (request.method === "state")
          result = {
            action: "read",
            space: "ag",
            operation: "read",
            result: {
              action: "snapshot",
              snapshot: runtime.snapshot("budget-session"),
            },
          };
        if (request.method === "search") result = context;
        if (
          (delayed === "hello" && request.method === "hello") ||
          (delayed === "state" && request.method === "state") ||
          (delayed === "search" && request.method === "search")
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
        assert.equal(settled, true, "a late phase must not exceed the shared turn budget");
        const result = await pending;
        const content = result.message?.content ?? "";
        if (delayed === "telemetry") assert.match(content, new RegExp(memory.id));
        else assert.doesNotMatch(content, new RegExp(memory.id));
        if (delayed === "search" || delayed === "telemetry") {
          assert.match(content, /<nmg_working_state>/u);
          assert.match(content, /Retain this state through optional recall work/u);
        } else assert.doesNotMatch(content, /Retain this state through optional recall work/u);
        const phase = {
          hello: "connection",
          state: "state.read",
          search: "search",
          telemetry: "controller.telemetry",
        }[delayed];
        assertTimedOutPhase(result, phase);
        assert.equal(
          seenRequests.includes("sessionActiveGraph:disclose"),
          false,
          "preparing typed context is not a disclosure write",
        );
        assert.ok(seenRequests.filter((request) => request.startsWith("state:")).length <= 1);
        t.mock.timers.tick(6_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(result.message?.content, content, "late work cannot alter persisted context");
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
