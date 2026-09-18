import assert from "node:assert/strict";
import test from "node:test";

import { normalize } from "./normalize.ts";
import { scale } from "./scale.ts";
import { summarize } from "./summarize.ts";
import { total } from "./total.ts";

/** The composition's own acceptance: the four builders over one input, rendered. */
test("the composed report is the four builders over one input", () => {
  const raw = [
    { name: "b", ms: 4 },
    { name: "x", ms: 0 },
    { name: "a", ms: 3 },
  ];
  const scaled = scale(normalize(raw), 2);
  assert.equal(summarize(scaled, total(scaled)), "a: 6ms\nb: 8ms\ntotal: 14ms");
});
