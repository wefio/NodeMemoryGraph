import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTemporalValidity,
  intersectScopes,
  scopesOverlap,
  validityIntervalsOverlap,
} from "../../src/core/semantic-domain.ts";

test("scope compatibility is conjunction intersection, not exact equality", () => {
  assert.deepEqual(
    intersectScopes({ project: "atlas" }, { project: "atlas", device: "laptop" }),
    { project: "atlas", device: "laptop" },
  );
  assert.equal(scopesOverlap({}, { project: "atlas" }), true);
  assert.equal(scopesOverlap({ project: "atlas" }, { project: "beacon" }), false);
  assert.equal(intersectScopes({ project: "atlas" }, { project: "beacon" }), null);
});

test("validity intervals are half-open and missing ends are unbounded", () => {
  const january = {
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-02-01T00:00:00.000Z",
  };
  assert.equal(
    validityIntervalsOverlap(january, {
      validFrom: "2026-01-15T00:00:00.000Z",
      validUntil: "2026-03-01T00:00:00.000Z",
    }),
    true,
  );
  assert.equal(
    validityIntervalsOverlap(january, { validFrom: "2026-02-01T00:00:00.000Z" }),
    false,
  );
  assert.equal(validityIntervalsOverlap({}, january), true);
});

test("temporal validation rejects malformed, empty, and reversed ranges", () => {
  assert.doesNotThrow(() =>
    assertTemporalValidity({
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-02-01T00:00:00.000Z",
    }),
  );
  assert.throws(() => assertTemporalValidity({ validFrom: "not-a-date" }), /validFrom/u);
  assert.throws(
    () =>
      assertTemporalValidity({
        validFrom: "2026-02-01T00:00:00.000Z",
        validUntil: "2026-02-01T00:00:00.000Z",
      }),
    /earlier than/u,
  );
  assert.throws(
    () =>
      assertTemporalValidity({
        validFrom: "2026-03-01T00:00:00.000Z",
        validUntil: "2026-02-01T00:00:00.000Z",
      }),
    /earlier than/u,
  );
});
