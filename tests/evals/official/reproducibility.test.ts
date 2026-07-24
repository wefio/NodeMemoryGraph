import assert from "node:assert/strict";
import test from "node:test";

import { sampleFingerprint } from "../../../evals/official/reproducibility.ts";

test("sample fingerprints are deterministic and content sensitive", () => {
  assert.equal(sampleFingerprint({ id: 1 }), sampleFingerprint({ id: 1 }));
  assert.notEqual(sampleFingerprint({ id: 1 }), sampleFingerprint({ id: 2 }));
  assert.match(sampleFingerprint([]), /^sha256:[a-f0-9]{64}$/u);
});
