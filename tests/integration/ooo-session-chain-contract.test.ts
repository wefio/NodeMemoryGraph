/**
 * A fused session fixes its tool surface once, when it is created, so the artifact schema's conclusion
 * cannot be the per-unit literal union a single attempt gets: it is loosened to a plain string, and the
 * envelope refuses a kind the unit does not admit. The rule the schema drops has to be carried by the
 * prompt instead, or the model is asked to guess and pays a turn for every wrong guess. A live fused run
 * died exactly there - aborted at turn 4 of a declared 3.
 *
 * These checks are offline. The runner refuses a pair of flags that disagree before it creates a runtime,
 * so no model is reached; the agreeing pair is what a live fused run exercises.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createPiSessionRunner } from "../../.pi/extensions/nmg/ooo-execution.ts";
import { preparePatchWork } from "../../src/integration/ooo-patch.ts";
import { patchSessionInput } from "../../src/integration/ooo-session-mechanism.ts";

function patchWork() {
  return preparePatchWork({
    taskId: "run-1:A",
    attempt: 1,
    instruction: "Repair the check.",
    files: { "src/integration/check-ticket.ts": "export const a = 1;\n" },
    editable: ["src/integration/check-ticket.ts"],
  });
}

test("a single-unit input leaves the conclusion kinds to the schema that carries them", () => {
  const frozen = patchWork();
  const input = patchSessionInput(frozen);
  assert.equal(input.looseConclusion, false);
  assert.equal(
    input.prompt.includes(JSON.stringify(frozen.work.admittedConclusions)),
    false,
    "the strict surface must not also name the kinds in the prompt",
  );
});

test("a chain input names the admitted conclusion kinds, because its schema cannot", () => {
  const frozen = patchWork();
  const input = patchSessionInput(frozen, { looseConclusion: true });
  assert.equal(input.looseConclusion, true);
  assert.ok(
    frozen.work.admittedConclusions.length > 1,
    "the fixture must admit more than one kind or the check proves nothing",
  );
  assert.ok(
    input.prompt.includes(JSON.stringify(frozen.work.admittedConclusions)),
    "a loosened surface must name the kinds it can no longer show",
  );
  assert.match(input.prompt, /a kind outside that list is refused/);
});

test("the runner refuses a chain session whose inputs were not built for one", async () => {
  const frozen = patchWork();
  await assert.rejects(
    createPiSessionRunner({
      provider: "unused",
      modelId: "unused",
      patchMode: true,
      first: patchSessionInput(frozen),
      chain: true,
    }),
    /a chain session needs inputs built with looseConclusion/,
  );
});

test("the runner refuses a loosened input on a session that is not a chain", async () => {
  const frozen = patchWork();
  await assert.rejects(
    createPiSessionRunner({
      provider: "unused",
      modelId: "unused",
      patchMode: true,
      first: patchSessionInput(frozen, { looseConclusion: true }),
    }),
    /this session is not a chain/,
  );
});
