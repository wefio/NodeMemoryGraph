import assert from "node:assert/strict";
import test from "node:test";

import { parsePiPromptTurns } from "../../scripts/pi-turns.ts";

test("Pi prompt parser preserves the legacy free-form single turn", () => {
  assert.deepEqual(parsePiPromptTurns(["why", "ANN? "]), ["why ANN?"]);
});

test("Pi prompt parser accepts repeated conventional --turn flags", () => {
  assert.deepEqual(parsePiPromptTurns(["--turn", "first", "--turn", " second "]), [
    "first",
    "second",
  ]);
});

test("Pi prompt parser rejects missing values and mixed syntax", () => {
  assert.throws(() => parsePiPromptTurns([]), /must not be empty/u);
  assert.throws(() => parsePiPromptTurns(["--turn"]), /requires a non-empty message/u);
  assert.throws(
    () => parsePiPromptTurns(["--turn", "first", "extra", "second"]),
    /expected --turn/u,
  );
});
