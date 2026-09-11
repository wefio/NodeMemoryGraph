import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardAdmission } from "./board-admission.ts";
import { expectedRename, verifyRenameCandidate } from "./patch-verifier.ts";
import {
  checkResultValid,
  sameCheck,
  type CheckResult,
  type CheckTicket,
} from "../../src/integration/ooo-check.ts";

test("contract: real syntax-check terminal identity is admitted by the board coordinator", async (t) => {
  const { gate } = fixture(t);
  const ticket = gate.issueCheck("A", "syntax-host");
  const source = readFileSync(
    new URL("../../src/integration/ooo-execution.ts", import.meta.url),
    "utf8",
  );
  const check = await verifyRenameCandidate(source, expectedRename(source), ticket.checkId);
  assert.equal(check.checkId, ticket.checkId);
  assert.equal(check.verdict, "accept");
  gate.now = Date.now();
  assert.equal(gate.submitCheck({ ticket, outcome: "passed", log: check.log! }), "accepted");
  assert.equal(gate.next(), "A");
  assert.deepEqual(gate.accepted(), {});
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ooo-check-"));
  const path = join(dir, "store.sqlite");
  const gate = new BoardAdmission(path);
  t.after(() => {
    gate.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { gate, path };
}

test("contract: terminal check releases A without accepting A or releasing C; duplicates persist", (t) => {
  const { gate, path } = fixture(t);
  const ticket = gate.issueCheck("A", "check-host");
  assert.equal(gate.next(), "B");
  assert.throws(() => gate.externalReady("interface-response"), /bound terminal/);
  const result = { ticket, outcome: "failed" as const, log: "real defect" };
  assert.equal(gate.submitCheck(result), "accepted");
  assert.equal(gate.next(), "A");
  assert.deepEqual(gate.accepted(), {});
  const reopened = new BoardAdmission(path);
  try {
    assert.equal(reopened.submitCheck(result), "duplicate");
    assert.equal(reopened.submitCheck({ ...result, outcome: "passed" }), "rejected");
  } finally {
    reopened.close();
  }
});

test("safety: replaced, wrong-owner, expired and cancelled check attempts cannot unblock A", (t) => {
  const { gate } = fixture(t);
  const old = gate.issueCheck("A", "host-1");
  const ticket = gate.issueCheck("A", "host-2");
  const result = { ticket, outcome: "passed" as const, log: "" };
  assert.equal(gate.submitCheck({ ...result, ticket: old }), "stale");
  assert.equal(gate.submitCheck({ ...result, ticket: { ...ticket, owner: "forged" } }), "stale");
  assert.equal(gate.cancelCheck(old), false);
  assert.equal(gate.cancelCheck(ticket), true);
  assert.equal(gate.submitCheck(result), "stale");
  const next = gate.issueCheck("A", "host-3");
  gate.now = next.expiresAt;
  assert.equal(gate.submitCheck({ ...result, ticket: next }), "stale");
  assert.equal(gate.next(), "B");
});

test("safety: stale input, oversized logs and undecidable results do not resolve the wait", (t) => {
  const { gate } = fixture(t);
  const ticket = gate.issueCheck("A", "host");
  const result = { ticket, outcome: "passed" as const, log: "" };
  assert.equal(gate.submitCheck({ ...result, log: "x".repeat(4001) }), "rejected");
  assert.equal(gate.submitCheck({ ...result, outcome: "undecidable" }), "accepted");
  assert.equal(gate.next(), "B");
  const retry = gate.issueCheck("A", "host");
  gate.observeRevision("A", "changed");
  assert.equal(gate.submitCheck({ ...result, ticket: retry }), "stale");
  assert.deepEqual(gate.accepted(), {});
});

/** A well-formed check identity; individual fields are substituted per test. */
const identity = (): CheckTicket => ({
  runId: "run-1",
  taskId: "A",
  checkId: "check-1",
  attempt: 1,
  inputDigest: "digest-1",
  owner: "host",
  expiresAt: 1_000,
});

// Regression: the board compares a submitted or replayed ticket against the stored
// one through sameCheck, so every field of the identity must be bound. Dropping a
// comparison lets a substituted ticket be treated as the issued check.
test("safety: sameCheck rejects a ticket whose attempt differs", () => {
  const ticket = identity();
  assert.equal(sameCheck({ ...ticket, attempt: ticket.attempt + 1 }, ticket), false);
  assert.equal(sameCheck(ticket, ticket), true);
});

test("safety: sameCheck rejects a ticket whose expiry differs", () => {
  const ticket = identity();
  assert.equal(sameCheck({ ...ticket, expiresAt: ticket.expiresAt + 1 }, ticket), false);
});

test("safety: sameCheck rejects a ticket whose input digest differs", () => {
  const ticket = identity();
  assert.equal(sameCheck({ ...ticket, inputDigest: "forged-digest" }, ticket), false);
});

// Regression: the admitted outcome set and the log size bound are exact.
test("safety: checkResultValid rejects an outcome outside the admitted set", () => {
  const ticket = identity();
  assert.equal(
    checkResultValid({ ticket, outcome: "bogus", log: "" } as unknown as CheckResult),
    false,
  );
  assert.equal(checkResultValid({ ticket, outcome: "passed", log: "" }), true);
});

test("contract: checkResultValid admits a log at exactly the size bound and rejects one byte more", () => {
  const ticket = identity();
  assert.equal(checkResultValid({ ticket, outcome: "passed", log: "x".repeat(4_000) }), true);
  assert.equal(checkResultValid({ ticket, outcome: "passed", log: "x".repeat(4_001) }), false);
});

// The same binding through the board: a substituted identity must not resolve A's wait.
test("safety: a replayed ticket with a substituted attempt cannot resolve A's wait", (t) => {
  const { gate } = fixture(t);
  const ticket = gate.issueCheck("A", "host");
  assert.equal(
    gate.submitCheck({
      ticket: { ...ticket, attempt: ticket.attempt + 1 },
      outcome: "passed",
      log: "",
    }),
    "stale",
  );
  assert.equal(gate.next(), "B");
});

test("safety: a replayed ticket with a substituted expiry cannot resolve A's wait", (t) => {
  const { gate } = fixture(t);
  const ticket = gate.issueCheck("A", "host");
  assert.equal(
    gate.submitCheck({
      ticket: { ...ticket, expiresAt: ticket.expiresAt + 1 },
      outcome: "passed",
      log: "",
    }),
    "stale",
  );
  assert.equal(gate.next(), "B");
});

test("safety: a ticket with a substituted input digest is not the issued check and cannot cancel it", (t) => {
  const { gate } = fixture(t);
  const ticket = gate.issueCheck("A", "host");
  assert.equal(gate.cancelCheck({ ...ticket, inputDigest: "forged-digest" }), false);
  assert.equal(gate.submitCheck({ ticket, outcome: "passed", log: "" }), "accepted");
});

test("safety: an unknown check outcome is rejected and never releases A", (t) => {
  const { gate } = fixture(t);
  const ticket = gate.issueCheck("A", "host");
  assert.equal(
    gate.submitCheck({ ticket, outcome: "bogus", log: "" } as unknown as CheckResult),
    "rejected",
  );
  assert.equal(gate.next(), "B");
});

test("contract: a terminal log at exactly the size bound is admitted and releases A", (t) => {
  const { gate } = fixture(t);
  const ticket = gate.issueCheck("A", "host");
  assert.equal(gate.submitCheck({ ticket, outcome: "passed", log: "x".repeat(4_000) }), "accepted");
});

// Regression: `reopen` is the board's fencing operation, and the fence is the
// attempt counter: "SET artifact=NULL, attempt=attempt+1, owner=NULL" retires every
// ticket, claim and artifact bound to the old attempt (bound() compares
// ticket.attempt to row.attempt, and a patch task's frozen digest is derived from
// the attempt). A board that clears the row but keeps the attempt
// (attempt=attempt) is indistinguishable from the intact one to any suite that
// never observes the counter across a reopen: the reopened task's next claim
// silently reuses the retired generation instead of advancing past it. Both tests
// below observe exactly that counter, so only a real bump can satisfy them.
test("safety: reopen consumes a fencing generation and the next claim skips the retired attempt", (t) => {
  const { gate } = fixture(t);
  const retired = gate.claim("B", "worker-1");
  assert.equal(retired.attempt, 1);
  // Nothing was accepted yet, so the reopen withdraws the live claim without
  // invalidating an artifact; the generation still has to be spent.
  assert.deepEqual(gate.reopen("B", "source revision withdrawn"), []);
  const resumed = gate.claim("B", "worker-2");
  // A reopen that keeps the attempt leaves the row at attempt 1, so this resume
  // would be issued the retired generation's successor (attempt 2) - the very
  // number the fault reuses. The intact board advances to attempt 3.
  assert.notEqual(resumed.attempt, retired.attempt + 1);
  assert.equal(resumed.attempt, retired.attempt + 2);
});

test("safety: each reopen consumes its own generation so repeated reopens cannot collapse", (t) => {
  const { gate } = fixture(t);
  assert.deepEqual(gate.reopen("B", "first withdrawal"), []);
  assert.deepEqual(gate.reopen("B", "second withdrawal"), []);
  const ticket = gate.claim("B", "worker-1");
  // Two reopens spend attempts 1 and 2 before the task is ever claimed, so the
  // first claim is attempt 3. A reopen that keeps the attempt leaves the counter
  // at 0 and the first claim would restart at attempt 1.
  assert.equal(ticket.attempt, 3);
});
