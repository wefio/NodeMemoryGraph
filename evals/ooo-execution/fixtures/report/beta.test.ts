import assert from "node:assert/strict";
import test from "node:test";

import { betaSection } from "./beta.ts";

test("beta numbers the rows from one, in the order given", () => {
  assert.deepEqual(betaSection(["x", "y"]), {
    id: "beta",
    title: "Beta",
    lines: ["1. x", "2. y"],
  });
  assert.deepEqual(betaSection(["only"]), { id: "beta", title: "Beta", lines: ["1. only"] });
});
