import assert from "node:assert/strict";
import test from "node:test";

import type { Step } from "./frozen.ts";
import { summarize } from "./summarize.ts";

/** The summary's own acceptance needs the frozen interface and nothing else: which steps and which
 *  total it is handed is the composition's business, and the composed check is where the real
 *  builders meet. */
const steps: Step[] = [
  { name: "a", ms: 1 },
  { name: "b", ms: 2 },
];

test("the report lists the steps it was given, then the total it was given", () => {
  assert.equal(summarize(steps, 3), "a: 1ms\nb: 2ms\ntotal: 3ms");
  assert.equal(summarize([], 0), "total: 0ms");
});
