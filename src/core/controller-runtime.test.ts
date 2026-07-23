import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerRuntime } from "./controller-runtime.ts";
import { NmgStore } from "./store.ts";

test("controller runtime learns from actual-use traces and persists exact state", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-runtime-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  const statePath = join(directory, "controller.json");
  try {
    const saved = store.remember({ statement: "Project color is cobalt", nodeName: "Project" });
    const context = store.searchContext("project color", { limit: 4 });
    assert.ok(context.activeGraph);
    const runtime = new ControllerRuntime(statePath);
    const before = runtime.shadow(context);
    assert.ok(before);
    assert.equal(before.trainingSteps, 0);

    store.recordActiveGraphUse(context.activeGraph.id, { usedMemoryIds: [saved.memory.id] });
    const trace = store.retrievalTrace(context.activeGraph.id);
    assert.ok(trace);
    assert.equal(runtime.observe(context, trace), true);
    assert.equal(runtime.trainingSteps, 1);
    assert.equal(runtime.observations, 1);

    const restored = new ControllerRuntime(statePath);
    assert.equal(restored.trainingSteps, 1);
    assert.equal(restored.observations, 1);
    assert.deepEqual(restored.shadow(context), runtime.shadow(context));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
