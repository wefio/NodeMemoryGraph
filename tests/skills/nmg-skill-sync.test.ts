import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  inspectNmgSkill,
  recoverInterruptedSync,
  syncNmgSkill,
} from "../../scripts/sync-nmg-skill.ts";

const script = resolve(import.meta.dirname, "../../scripts/sync-nmg-skill.ts");

test("NMG Skill sync recoverably replaces drifted and stale installed content", (context) => {
  const root = mkdtempSync(join(tmpdir(), "nmg-skill-sync-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "nmg-memory");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "outdated\n");
  writeFileSync(join(target, "stale.md"), "stale\n");

  const before = inspectNmgSkill(target);
  assert.equal(before.inSync, false);
  assert.ok(before.changed.includes("SKILL.md"));
  assert.ok(before.extra.includes("stale.md"));

  const after = syncNmgSkill(target);
  assert.equal(after.synchronized, true);
  assert.equal(after.inSync, true);
  assert.equal(existsSync(join(target, "references", "natural-evidence.md")), true);
  assert.equal(existsSync(join(target, "stale.md")), false);
});

test("NMG Skill sync refuses a broad or incorrectly named target", () => {
  assert.throws(() => syncNmgSkill(join(tmpdir(), "skills")), /non-nmg-memory target/u);
  assert.throws(
    () => syncNmgSkill(resolve(import.meta.dirname, "../../skills/nmg-memory")),
    /source and target must differ/u,
  );
});

test("NMG Skill sync installs into a missing target", (context) => {
  const root = mkdtempSync(join(tmpdir(), "nmg-skill-missing-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "nmg-memory");

  const report = syncNmgSkill(target);
  assert.equal(report.inSync, true);
  assert.equal(existsSync(join(target, "SKILL.md")), true);
});

test("NMG Skill sync recovers an interrupted swap before continuing", (context) => {
  const root = mkdtempSync(join(tmpdir(), "nmg-skill-recover-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "nmg-memory");
  const backup = join(root, ".nmg-memory.backup-crashed");
  const staging = join(root, ".nmg-memory.sync-crashed");
  mkdirSync(backup);
  mkdirSync(staging);
  writeFileSync(join(backup, "sentinel.txt"), "recover me\n");

  recoverInterruptedSync(target);
  assert.equal(existsSync(join(target, "sentinel.txt")), true);
  assert.equal(existsSync(staging), false);

  assert.equal(syncNmgSkill(target).inSync, true);
});

test("NMG Skill sync refuses a concurrent live writer", (context) => {
  const root = mkdtempSync(join(tmpdir(), "nmg-skill-lock-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "nmg-memory");
  writeFileSync(
    join(root, ".nmg-memory.sync.lock"),
    JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
  );

  assert.throws(() => syncNmgSkill(target), /already running/u);
});

test("NMG Skill check exits one for drift and CLI options fail closed", (context) => {
  const root = mkdtempSync(join(tmpdir(), "nmg-skill-cli-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "nmg-memory");

  const drift = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--check", "--target", target],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /"inSync": false/u);

  const missingValue = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--target"],
    { encoding: "utf8" },
  );
  assert.notEqual(missingValue.status, 0);
  assert.match(missingValue.stderr, /--target requires a value/u);

  const unknown = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--unknown"],
    { encoding: "utf8" },
  );
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown option/u);

  const positional = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "unexpected"],
    { encoding: "utf8" },
  );
  assert.notEqual(positional.status, 0);
  assert.match(positional.stderr, /unexpected argument/u);
});
