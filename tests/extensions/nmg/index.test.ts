import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import nmgExtension, {
  formatMemoryContext,
  formatSearchHeaders,
} from "../../../.pi/extensions/nmg/index.ts";
import { isProcessAlive, readServerState, serverStatePath } from "../../../src/cli/lifecycle.ts";

function extensionHarness() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  nmgExtension({
    on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
  } as never);
  return { handlers, tools };
}

test("Pi adapter exposes only the stable gRPC tool surface", () => {
  assert.deepEqual([...extensionHarness().tools.keys()], ["nmg_remember", "nmg_get", "nmg_search"]);
});

test("Pi adapter starts, recalls through, and closes its owned daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-grpc-"));
  const previous = process.env.NMG_DATA_DIR;
  process.env.NMG_DATA_DIR = directory;
  const sessionManager = { getSessionId: () => "grpc-test-session" };
  try {
    const { handlers, tools } = extensionHarness();
    const remember = await tools.get("nmg_remember")!.execute(
      "remember",
      {
        statement: "Atlas must use SQLite for offline operation.",
        nodeName: "Atlas storage",
        memoryType: "constraint",
        sourceActor: "user",
        evidence: "Atlas must use SQLite for offline operation.",
        writeReason: "Durable project constraint",
      },
      undefined,
      undefined,
      { sessionManager },
    );
    assert.match(remember.content[0].text, /saved/i);

    const started = readServerState(serverStatePath(join(directory, "nmg.sqlite")));
    assert.equal(started?.transport, "grpc");
    assert.equal(isProcessAlive(started!.pid), true);

    const recalled = await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    );
    assert.match(recalled.systemPrompt, /Atlas must use SQLite/);

    const searched = await tools
      .get("nmg_search")!
      .execute("search", { query: "Atlas database" }, undefined, undefined, { sessionManager });
    assert.match(searched.content[0].text, /NMG SEARCH HEADERS/);

    await handlers.get("session_shutdown")!({}, { sessionManager });
    assert.equal(isProcessAlive(started!.pid), false);
  } finally {
    if (previous === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("formatters keep search headers compact and exact evidence separate", () => {
  const context = {
    results: [
      {
        memory: {
          id: "memory-1",
          statement: "Use SQLite.",
          memoryType: "constraint",
          tier: 1,
          truthStatus: "asserted",
          scope: { project: "atlas" },
        },
        node: { canonicalName: "Atlas storage" },
        evidence: { content: "The Atlas project must use SQLite because it works offline." },
      },
    ],
  } as never;
  assert.doesNotMatch(formatSearchHeaders(context), /works offline/);
  assert.match(formatMemoryContext(context), /works offline/);
});
