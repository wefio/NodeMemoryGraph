import assert from "node:assert/strict";
import test from "node:test";

import { normalize } from "./normalize.ts";

test("normalize keeps the steps that took time, in name order", () => {
  assert.deepEqual(
    normalize([
      { name: "b", ms: 2 },
      { name: "x", ms: 0 },
      { name: "a", ms: 1 },
    ]),
    [
      { name: "a", ms: 1 },
      { name: "b", ms: 2 },
    ],
  );
  assert.deepEqual(normalize([]), []);
});
