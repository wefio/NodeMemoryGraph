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
import { patchPrompt, preparePatchWork } from "../../src/integration/ooo-patch.ts";
import {
  ARTIFACT_TOOL,
  patchSessionInput,
  usageTotals,
} from "../../src/integration/ooo-session-mechanism.ts";

function patchWork() {
  return preparePatchWork({
    taskId: "run-1:A",
    attempt: 1,
    instruction: "Repair the check.",
    files: { "src/integration/check-ticket.ts": "export const a = 1;\n" },
    editable: ["src/integration/check-ticket.ts"],
  });
}

test("a single-unit input is exactly the schema-carrying prompt, so a control arm is untouched", () => {
  const frozen = patchWork();
  const input = patchSessionInput(frozen);
  assert.equal(input.looseConclusion, false);
  assert.equal(
    input.prompt,
    patchPrompt(frozen, ARTIFACT_TOOL),
    "the strict path must not gain a note, or a recorded control arm stops describing this code",
  );
});

test("a chain input names the admitted kinds and the tools this unit may use", () => {
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
  // The envelope refuses a submission that carries both channels, and no schema can say that.
  assert.match(input.prompt, /never both/);
  // This unit has no check and no declared requirement, while the session exposes both tools.
  assert.match(input.prompt, /this unit has no check/);
  assert.match(input.prompt, /call only read_snapshot and submit_artifact/);
});

/** A unit that does have a check keeps it, and the note must say so rather than denying it. */
test("a chain input names the check when the unit has one", () => {
  const frozen = patchWork();
  const input = patchSessionInput(frozen, {
    looseConclusion: true,
    check: { label: "the unit check", maxRuns: 1, run: async () => ({ ok: true, output: "" }) },
  });
  assert.match(input.prompt, /the check the unit check/);
  assert.match(input.prompt, /call only read_snapshot, run_check and submit_artifact/);
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

/**
 * The provider's own split, summed. A token total adds four differently-priced things together and
 * cannot be taken apart again, so the numbers a cost claim needs have to be read as they arrive.
 * A split the provider did not report stays absent rather than becoming zero spent.
 */
test("the usage split is summed per assistant turn, and a missing field is not a zero", () => {
  const turns = [
    { role: "user", usage: undefined },
    {
      role: "assistant",
      usage: {
        totalTokens: 100,
        input: 20,
        output: 15,
        cacheRead: 60,
        cacheWrite: 5,
        cost: { total: 0.25 },
      },
    },
    { role: "assistant", usage: { totalTokens: 10, cacheRead: 10 } },
  ];
  assert.deepEqual(usageTotals(turns), {
    total: 110,
    input: 20,
    output: 15,
    cacheRead: 70,
    cacheWrite: 5,
    cost: 0.25,
  });
  // Only assistant turns count: a user turn's usage is not the model's spend.
  assert.deepEqual(usageTotals([turns[0]!]), {
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  });
});
