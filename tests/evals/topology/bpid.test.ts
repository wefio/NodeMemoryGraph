import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateCurve,
  identityCandidateFeatures,
  rollbackProbe,
  type BpidPair,
} from "../../../evals/topology/bpid.ts";

const positive: BpidPair = {
  profile1: {
    fullname: "Corrie Arreola",
    email: ["corrie@example.com"],
    phone: ["+1 555 0100"],
    addr: ["10 Lake Road, Austin TX"],
    dob: "1953-11-09",
  },
  profile2: {
    fullname: "Arreola, Corrie",
    email: ["corrie@example.com"],
    phone: ["15550100"],
    addr: ["10 Lake Rd Austin Texas"],
    dob: "09 Nov 1953",
  },
  match: "True",
};

const negative: BpidPair = {
  profile1: positive.profile1,
  profile2: {
    fullname: "Charlie Warner",
    email: ["charlie@elsewhere.net"],
    phone: ["+1 555 9999"],
    addr: ["800 Hill Street, Denver CO"],
    dob: "2001-02-03",
  },
  match: "False",
};

test("BPID candidate features rank multi-field identity above an unrelated profile", () => {
  const same = identityCandidateFeatures(positive.profile1, positive.profile2);
  const different = identityCandidateFeatures(negative.profile1, negative.profile2);
  assert.ok(same.score > 0.98);
  assert.ok(same.score > different.score);
});

test("BPID threshold curve exposes candidate recall, precision, and reduction", () => {
  const [point] = candidateCurve([positive, negative], [0.9]);
  assert.equal(point!.candidates, 1);
  assert.equal(point!.truePositives, 1);
  assert.equal(point!.falsePositives, 0);
  assert.equal(point!.recall, 1);
  assert.equal(point!.precision, 1);
  assert.equal(point!.reductionRatio, 0.5);
});

test("BPID rollback probe restores both nodes after a gated merge", () => {
  const result = rollbackProbe([positive]);
  assert.equal(result.attempted, 1);
  assert.equal(result.restored, 1);
  assert.equal(result.falsePositiveRollbacks, 0);
});
