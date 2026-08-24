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

test("NMG Skill natural evidence loop separates observation, calibration, and activation", () => {
  const quickStart = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
  const naturalEvidence = readFileSync(
    resolve(skillRoot, "references/natural-evidence.md"),
    "utf8",
  );

  assert.match(quickStart, /natural evidence loop/u);
  assert.match(
    naturalEvidence,
    /Retrieval, answer reuse, task\s+completion by itself, silence, and lack of correction are not claim evidence/u,
  );
  assert.match(naturalEvidence, /NMG_SHADOW_COLLECTION_ORIGIN/u);
  assert.match(naturalEvidence, /eval:controller-dataset -- --compact/u);
  assert.match(naturalEvidence, /writes a rollbackable candidate artifact; it does not activate it/u);
  assert.match(naturalEvidence, /must keep the corresponding production actuator disabled/u);
});
