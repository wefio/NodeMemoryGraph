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
    const configPath = join(directory, "configs", "nmg_policy.yaml");
    assert.equal(existsSync(configPath), true);
    assert.match(readFileSync(configPath, "utf8"), /^_base_: _base_\/default\.yaml$/mu);
    assert.match(readFileSync(configPath, "utf8"), /max_completion_tokens: 4096/u);
    const rolloutPath = join(directory, "skillopt", "envs", "nmg_policy", "rollout.py");
    assert.doesNotMatch(readFileSync(rolloutPath, "utf8"), /min\(max_completion_tokens, 256\)/u);
    for (const script of ["train.py", "eval_only.py"]) {
      const source = readFileSync(join(directory, "scripts", script), "utf8");
      assert.equal(source.match(/_ENV_REGISTRY\["nmg_policy"\]/gu)?.length, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
