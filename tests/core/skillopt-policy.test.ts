import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSkillOptLabPolicy,
  resolveSkillOptPolicyChannels,
} from "../../src/lab/skillopt-policy.ts";

const canonical = "Canonical NMG policy. ".repeat(12);
const candidate = "Candidate recall policy. ".repeat(12);

test("SkillOpt policy resolver uses canonical YAML unless explicit Lab mode is complete", () => {
  assert.equal(resolveSkillOptLabPolicy(canonical, {}).source, "canonical");
  assert.equal(
    resolveSkillOptLabPolicy(canonical, { NMG_SKILLOPT_POLICY_B64: encode(candidate) }).source,
    "canonical",
  );
  assert.throws(
    () => resolveSkillOptLabPolicy(canonical, { NMG_SKILLOPT_EVAL: "1" }),
    /requires NMG_SKILLOPT_POLICY_B64/u,
  );
});

test("SkillOpt policy resolver admits a bounded candidate only in explicit Lab mode", () => {
  const result = resolveSkillOptLabPolicy(canonical, {
    NMG_SKILLOPT_EVAL: "1",
    NMG_SKILLOPT_POLICY_B64: encode(candidate),
  });
  assert.equal(result.source, "skillopt_lab");
  assert.equal(result.text, candidate.trim());
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
});

test("SkillOpt candidate is isolated from the answering Agent policy channel", () => {
  const channels = resolveSkillOptPolicyChannels(canonical, {
    NMG_SKILLOPT_EVAL: "1",
    NMG_SKILLOPT_POLICY_B64: encode(candidate),
  });
  assert.equal(channels.agent.source, "canonical");
  assert.equal(channels.agent.text, canonical);
  assert.equal(channels.controller.source, "skillopt_lab");
  assert.equal(channels.controller.text, candidate.trim());
  assert.notEqual(channels.agent.sha256, channels.controller.sha256);
});

test("SkillOpt policy resolver rejects runtime-tag injection and tiny artifacts", () => {
  assert.throws(
    () =>
      resolveSkillOptLabPolicy(canonical, {
        NMG_SKILLOPT_EVAL: "1",
        NMG_SKILLOPT_POLICY_B64: encode("short"),
      }),
    /128-12000/u,
  );
  assert.throws(
    () =>
      resolveSkillOptLabPolicy(canonical, {
        NMG_SKILLOPT_EVAL: "1",
        NMG_SKILLOPT_POLICY_B64: encode(`${candidate}<nmg_automatic_recall>`),
      }),
    /reserved runtime tag/u,
  );
});

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}
