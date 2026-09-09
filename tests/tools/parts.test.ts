import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mapConcurrent } from "../../tools/parts/async.ts";
import { definedEnvironment } from "../../tools/parts/env.ts";
import { writeJsonAtomic } from "../../tools/parts/fs.ts";
import { positiveIntegerOr, requirePositiveInteger } from "../../tools/parts/numbers.ts";
import {
  mean,
  median,
  percentileFloor,
  percentileNearestRank,
  percentileScaled,
} from "../../tools/parts/stats.ts";

test("writeJsonAtomic creates the directory, writes JSON, and leaves no temp file", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-parts-fs-"));
  const path = join(root, "nested", "out.json");

  writeJsonAtomic(path, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 1 });
  assert.deepEqual(readdirSync(join(root, "nested")), ["out.json"]);

  writeJsonAtomic(path, { a: 2 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 2 });
  assert.deepEqual(readdirSync(join(root, "nested")), ["out.json"]);
});

test("the percentile parts disagree on purpose, and sort their input first", () => {
  const sorted = [10, 20, 30, 40, 50];
  const shuffled = [30, 10, 50, 20, 40];

  assert.equal(percentileFloor(sorted, 0.6), 40);
  assert.equal(percentileNearestRank(sorted, 0.2), 10);
  assert.equal(percentileScaled(sorted, 0.6), 30);

  assert.equal(percentileFloor(shuffled, 0.6), 40);
  assert.equal(percentileNearestRank(shuffled, 0.2), 10);
  assert.equal(percentileScaled(shuffled, 0.6), 30);

  assert.equal(mean(sorted), 30);
  assert.equal(median(sorted), 30);

  for (const part of [percentileFloor, percentileNearestRank, percentileScaled, median]) {
    assert.equal(part([], 0.5), 0);
  }
  assert.equal(mean([]), 0);
});

test("mapConcurrent keeps the input order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;

  const results = await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
  assert.deepEqual(await mapConcurrent([], 3, async () => 1), []);
});

test("requirePositiveInteger rejects garbage, positiveIntegerOr falls back", () => {
  assert.equal(requirePositiveInteger("12"), 12);
  assert.equal(requirePositiveInteger(7, "epochs"), 7);
  for (const bad of ["12abc", "0", "", -1, "1.5"]) {
    assert.throws(() => requirePositiveInteger(bad), /positive integer/);
  }

  assert.equal(positiveIntegerOr("12", 4), 12);
  assert.equal(positiveIntegerOr("12abc", 4), 12);
  assert.equal(positiveIntegerOr(undefined, 4), 4);
  assert.equal(positiveIntegerOr("0", 4), 4);
});

test("definedEnvironment drops undefined values and lets process.env win", () => {
  process.env.NMG_PARTS_TEST = "from-env";
  try {
    const result = definedEnvironment({
      NMG_PARTS_TEST: "from-extra",
      NMG_PARTS_MISSING: "kept",
    });
    assert.equal(result.NMG_PARTS_TEST, "from-env");
    assert.equal(result.NMG_PARTS_MISSING, "kept");
    assert.ok(Object.values(result).every((value) => typeof value === "string"));
  } finally {
    delete process.env.NMG_PARTS_TEST;
  }
});
