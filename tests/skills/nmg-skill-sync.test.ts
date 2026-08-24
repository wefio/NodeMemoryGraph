import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectNmgSkill, syncNmgSkill } from "../../scripts/sync-nmg-skill.ts";

test("NMG Skill sync atomically replaces drifted and stale installed content", (context) => {
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
});
