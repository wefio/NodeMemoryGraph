// The layer a test belongs to decides what a developer runs and what a failure means, so the
// classifier has to be checkable without trusting its own output: a synthetic tree proves the
// three decisions, and the real tree proves nothing fell outside them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LAYERS,
  assignOwnership,
  checkLayers,
  classifyTest,
  collectTestFiles,
  partitionTests,
  type TestLayer,
} from "../../tools/test-layers.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-test-layers-"));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source, "utf8");
  }
  return root;
}

test("the three layers partition every test file exactly once", () => {
  const files = collectTestFiles();
  const report = partitionTests();
  const seen = new Set<string>();
  for (const layer of LAYERS) {
    for (const file of report.get(layer)!.files) {
      assert.ok(!seen.has(file), `${file} appears in more than one layer`);
      seen.add(file);
    }
  }
  assert.deepEqual([...seen].sort(), files, "a test file outside every layer would never run");
});

test("the real tree passes its own check", () => {
  assert.deepEqual(checkLayers(), []);
});

test("the classifier reads the boundary the test crosses, not its folder", () => {
  // Assembled so this guard file does not itself look like a daemon-spawning test.
  const daemonClient = ["../../../src/cli/daemon", "-client.ts"].join("");
  const cases: Array<[string, TestLayer]> = [
    ["const child = spawn(node, [script]);", "e2e"],
    [`import { start } from '${daemonClient}';`, "e2e"],
    ["const db = new DatabaseSync(join(dir, 'store.db'));", "integration"],
    ["assert.equal(rank(a), 2);", "unit"],
  ];
  for (const [source, expected] of cases) {
    assert.equal(classifyTest("tests/core/probe.test.ts", source), expected, source);
  }
});

test("an override moves a file, and the check reports one that stopped mattering", () => {
  const root = fixture({
    "tests/core/spawning.test.ts": "spawn(node, ['--version']);",
    "tests/core/pure.test.ts": "assert.equal(1, 1);",
  });
  try {
    const overrides = new Map([
      ["tests/core/spawning.test.ts", { layer: "integration" as const, reason: "fixture" }],
    ]);
    assert.equal(
      classifyTest("tests/core/spawning.test.ts", "spawn(node, []);", overrides),
      "integration",
    );
    assert.deepEqual(checkLayers(root, overrides), []);

    const redundant = new Map([
      ["tests/core/pure.test.ts", { layer: "unit" as const, reason: "fixture" }],
    ]);
    assert.match(checkLayers(root, redundant).join("\n"), /redundant/);

    const stale = new Map([
      ["tests/core/gone.test.ts", { layer: "unit" as const, reason: "fixture" }],
    ]);
    assert.match(checkLayers(root, stale).join("\n"), /no longer exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module belongs to the cheapest tier that reaches it", () => {
  const coverage = (pct: number) => ({ lines: { total: 100, covered: pct, pct } });
  const owned = assignOwnership([
    {
      layer: "unit",
      modules: new Map([
        ["src/a.ts", coverage(95)],
        ["src/b.ts", coverage(40)],
      ]),
    },
    {
      layer: "integration",
      modules: new Map([
        ["src/b.ts", coverage(92)],
        ["src/c.ts", coverage(20)],
      ]),
    },
    { layer: "e2e", modules: new Map([["src/c.ts", coverage(88)]]) },
  ]);

  assert.deepEqual([...owned.get("unit")!.keys()], ["src/a.ts"], "unit keeps what it reaches");
  assert.deepEqual([...owned.get("integration")!.keys()], ["src/b.ts"], "cheaper tier wins");
  assert.deepEqual(
    [...owned.get("e2e")!.keys()],
    ["src/c.ts"],
    "when no tier reaches the target, the furthest one owns it",
  );
});
