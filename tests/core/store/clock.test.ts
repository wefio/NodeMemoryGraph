import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { currentlyValid, notExpired } from "../../../src/core/store/clock.ts";

test("the SQLite clock grace admits near-boundary rows without admitting distant rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const result = db.prepare(
      "WITH m(valid_from, valid_until, expires_at) AS (VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now',?), NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now',?))) SELECT " +
        currentlyValid("m") +
        " AS valid," +
        notExpired("m") +
        " AS fresh FROM m",
    );
    assert.deepEqual({ ...result.get("+0.020 seconds", "-0.020 seconds") }, { valid: 1, fresh: 1 });
    assert.deepEqual({ ...result.get("+1 second", "-1 second") }, { valid: 0, fresh: 0 });
  } finally {
    db.close();
  }
});
