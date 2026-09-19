import assert from "node:assert/strict";
import test from "node:test";

import { total } from "./total.ts";

test("total adds the steps it was given, and an empty pipeline is zero", () => {
  assert.equal(
    total([
      { name: "a", ms: 1 },
      { name: "b", ms: 2 },
    ]),
    3,
  );
  assert.equal(total([]), 0);
});
