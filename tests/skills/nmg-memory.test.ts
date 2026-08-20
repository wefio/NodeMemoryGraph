import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const skillRoot = resolve(import.meta.dirname, "../../skills/nmg-memory");

test("NMG Skill fails closed on an incompatible shared daemon", () => {
  const quickStart = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
  const operations = readFileSync(resolve(skillRoot, "references/operations.md"), "utf8");

  assert.match(quickStart, /inspect both `running` and `compatible`/u);
  assert.match(quickStart, /`compatible=false`/u);
  assert.match(quickStart, /do not reuse or automatically replace it/u);
  assert.match(operations, /Do not stop,\s*restart, or replace it automatically/u);
  assert.match(operations, /never\s*fall back to an older RPC name/u);
});
