import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("first-recall tutorial runs the isolated remember-search-get loop", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.["tutorial:first-recall"],
    "node --experimental-strip-types scripts/tutorial-first-recall.ts",
  );
  assert.ok(
    packageJson.files?.includes("scripts/tutorial-first-recall.ts"),
    "the tutorial command remains available in a packed checkout",
  );

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", resolve(root, "scripts/tutorial-first-recall.ts"), "--non-interactive"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NMG_EMBED_AUTO_SYNC: "0",
        NMG_SUMMARY_WORKER: "0",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Step 1\/4: inspect an empty isolated store/);
  assert.match(result.stdout, /Step 2\/4: remember one durable preference/);
  assert.match(result.stdout, /Step 3\/4: search compact headers/);
  assert.match(result.stdout, /Step 4\/4: load exact evidence through the Active Graph/);
  assert.match(result.stdout, /Active Graph: [0-9a-f-]{36}/);
  assert.match(result.stdout, /Exact evidence: The user prefers concise technical answers\./);

  const temporaryStore = result.stdout.match(/Temporary store: (.+)/)?.[1]?.trim();
  assert.ok(temporaryStore, "tutorial reports its isolated storage path");
  assert.equal(existsSync(temporaryStore), false, "tutorial removes its temporary store");
  assert.match(result.stdout, /Tutorial complete; temporary data removed\./);
});
