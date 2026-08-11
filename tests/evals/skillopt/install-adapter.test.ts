import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installSkillOptAdapter } from "../../../evals/skillopt/install-adapter.ts";

test("SkillOpt installer copies a thin adapter and patches both lazy registries idempotently", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-skillopt-"));
  try {
    mkdirSync(join(directory, "scripts"), { recursive: true });
    mkdirSync(join(directory, "configs"), { recursive: true });
    for (const script of ["train.py", "eval_only.py"])
      writeFileSync(join(directory, "scripts", script), "def get_adapter(cfg: dict):\n    pass\n");
    installSkillOptAdapter(directory);
    installSkillOptAdapter(directory);
    assert.equal(existsSync(join(directory, "skillopt", "envs", "nmg_policy", "adapter.py")), true);
    assert.equal(existsSync(join(directory, "configs", "nmg_policy.yaml")), true);
    for (const script of ["train.py", "eval_only.py"]) {
      const source = readFileSync(join(directory, "scripts", script), "utf8");
      assert.equal(source.match(/_ENV_REGISTRY\["nmg_policy"\]/gu)?.length, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
