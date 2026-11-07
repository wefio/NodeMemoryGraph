import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgStore } from "../../src/core/store.ts";
import { parseAgentActivity } from "../../src/core/agent-activity.ts";
import {
  executeCoordinationState,
  prepareCoordinationSurface,
} from "../../src/integration/coordination-state.ts";

test("board activity combines independent reports and capabilities with lease and session isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-activity-"));
  const store = new NmgStore(join(dir, "fixture.sqlite"));
  try {
    assert.equal(store.readAgentActivity("agent", "s").state, "unknown");
    const write = (activity: Record<string, unknown>) =>
      executeCoordinationState(store, "agentActivity", {
        space: "board",
        action: "write",
        agentId: "agent",
        sessionId: "s",
        activity,
      });
    write({
      source: "harness",
      state: "idle",
      capabilities: ["batch-enqueue", "processing-observation"],
      ttlSeconds: 300,
    });
    const busy = write({ state: "busy", capabilities: ["manual-coordination"], ttlSeconds: 60 });
    assert.equal(busy.agentActivity?.state, "busy");
    assert.deepEqual(busy.agentActivity?.capabilities, [
      "batch-enqueue",
      "manual-coordination",
      "processing-observation",
    ]);
    write({ source: "harness", state: "idle" });
    assert.equal(
      store.readAgentActivity("agent", "s").state,
      "busy",
      "harness idle cannot release the Agent's declaration",
    );
    assert.equal(store.readAgentActivity("agent", "other").state, "unknown");
    const later = store.readAgentActivity("agent", "s", new Date(Date.now() + 61000).toISOString());
    assert.equal(later.state, "idle");
    assert.deepEqual(later.capabilities, ["batch-enqueue", "processing-observation"]);
    const version = busy.agentActivity!.reports.find(
      (report) => report.source === "agent",
    )!.version;
    write({ state: "idle", expectedVersion: version });
    assert.throws(() => write({ state: "busy", expectedVersion: version }), /version changed/);
    assert.equal(store.readAgentActivity("agent", "s").state, "idle");
    const unknown = write({
      source: "harness",
      state: "unknown",
      capabilities: ["stdout-context"],
    });
    assert.ok(unknown.agentActivity?.capabilities.includes("stdout-context"));
    assert.match(prepareCoordinationSurface(unknown).text, /session=s processing=idle/);
    assert.equal(store.getAgentWorkStatus("agent").sessions?.[0]?.state, "idle");
    assert.throws(() => parseAgentActivity({ state: "ready", ttlSeconds: 20 }), /processing state/);
    assert.throws(() => parseAgentActivity({ state: "busy", ttlSeconds: 0 }), /ttlSeconds/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
