import assert from "node:assert/strict";
import test from "node:test";

import { alphaSection } from "./alpha.ts";

test("alpha lists the rows it was given, sorted, without blanks", () => {
  assert.deepEqual(alphaSection(["b=2", "", "a=1"]), {
    id: "alpha",
    title: "Alpha",
    lines: ["a=1", "b=2"],
  });
  assert.deepEqual(alphaSection([]), { id: "alpha", title: "Alpha", lines: [] });
});
