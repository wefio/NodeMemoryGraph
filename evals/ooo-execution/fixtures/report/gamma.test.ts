import assert from "node:assert/strict";
import test from "node:test";

import { gammaSection } from "./gamma.ts";

test("gamma upper-cases the rows and keeps the first of a duplicate", () => {
  assert.deepEqual(gammaSection(["a", "b", "a"]), {
    id: "gamma",
    title: "Gamma",
    lines: ["A", "B"],
  });
  assert.deepEqual(gammaSection([]), { id: "gamma", title: "Gamma", lines: [] });
});
