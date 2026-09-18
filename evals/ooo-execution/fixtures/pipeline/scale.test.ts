import assert from "node:assert/strict";
import test from "node:test";

import { scale } from "./scale.ts";

test("scale multiplies every step and rounds down to whole milliseconds", () => {
  assert.deepEqual(scale([{ name: "a", ms: 3 }], 1.5), [{ name: "a", ms: 4 }]);
  assert.deepEqual(
    scale(
      [
        { name: "a", ms: 2 },
        { name: "b", ms: 1 },
      ],
      2,
    ),
    [
      { name: "a", ms: 4 },
      { name: "b", ms: 2 },
    ],
  );
  assert.deepEqual(scale([], 3), []);
});
