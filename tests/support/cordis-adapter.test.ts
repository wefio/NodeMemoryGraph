import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as adapter from "./cordis-adapter.ts";

test("Cordis adapter exposes only the lifecycle factory", () => {
  assert.deepEqual(Object.keys(adapter), ["createTestRuntime"]);
});

test("Cordis remains isolated from NMG production modules", () => {
  const adapterSource = readFileSync(new URL("./cordis-adapter.ts", import.meta.url), "utf8");
  const fixtureSource = readFileSync(new URL("./test-runtime.ts", import.meta.url), "utf8");

  assert.match(adapterSource, /@deepseek-ai\/cordis/);
  assert.doesNotMatch(adapterSource, /(?:\.\.\/)+src\//);
  assert.doesNotMatch(fixtureSource, /@deepseek-ai\/cordis/);
});

test("Cordis adapter disposes registered effects in reverse order", async () => {
  const events: string[] = [];
  const runtime = adapter.createTestRuntime();

  await runtime.use((scope) => {
    scope.effect(() => () => events.push("first"), "first");
  });
  await runtime.use((scope) => {
    scope.effect(() => () => events.push("second"), "second");
  });

  await runtime.dispose();
  await runtime.dispose();
  assert.deepEqual(events, ["second", "first"]);
});
