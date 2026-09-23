/**
 * One home for the identity of work, so a stored digest cannot come to mean two things.
 *
 * The rule these cases pin is not the hash itself - node owns that - but the convention a reader of a
 * stored digest depends on: sha256, hex, full length, over exactly the bytes or the JSON text the caller
 * froze. The mutants that catch a drift in that convention are named in `tools/mutation-teeth.ts` for
 * `src/integration/work-identity.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { workDigest, workDigestOf } from "../../src/integration/work-identity.ts";

test("the identity of work bytes is sha256 in hex, at full length", () => {
  const bytes = Buffer.from("deliver these bytes\n", "utf8");
  // The known answer, from `printf 'deliver these bytes\n' | sha256sum` at the time of writing: a constant
  // rather than another call to the same hash, so the case fails if the encoding changes rather than only
  // if both sides change together. Text and bytes are asserted to be the same rule.
  assert.equal(
    workDigest(bytes),
    "33f9ff34371d8a7e7cd9810ca147946bfdcd1894160bd7c93eeb4a650205fd44",
  );
  assert.equal(workDigest("deliver these bytes\n"), workDigest(bytes));
  assert.match(workDigest(bytes), /^[0-9a-f]{64}$/u);
  assert.notEqual(workDigest(bytes), workDigest("deliver these bytes"));
});

test("the JSON variant digests JSON text, so key order is the caller's", () => {
  assert.equal(workDigestOf({ a: 1, b: 2 }), workDigest(JSON.stringify({ a: 1, b: 2 })));
  // Not a defect to fix here: a caller that needs one identity per shape freezes the shape first, which is
  // what `preparePatchWork` does before it digests. This case exists so that rule is written down.
  assert.notEqual(workDigestOf({ a: 1, b: 2 }), workDigestOf({ b: 2, a: 1 }));
});
