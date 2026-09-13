import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoardAdmission,
  channel,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";
import { expectedRename } from "../../src/integration/ooo-verifier.ts";
import type { PatchSubmission } from "../../src/integration/ooo-patch.ts";

const source = readFileSync(
  new URL("../../src/integration/ooo-execution.ts", import.meta.url),
  "utf8",
);
const expected = expectedRename(source);
const proposal = () => JSON.stringify({ digest: "", files: [] });

/** Host check: an exact-rename patch, or a conclusion. Conclusions are admitted
 *  only when they carry evidence; the host decides, not the worker. */
async function verifyRename(submission: PatchSubmission) {
  if (submission.kind === "conclusion") return submission.evidence ? "accept" : "reject";
  const candidate = submission.files;
  if (candidate["src/integration/ooo-execution.ts"] !== expected) return "reject" as const;
  const directory = mkdtempSync(join(tmpdir(), "ooo-candidate-"));
  try {
    mkdirSync(join(directory, "src/integration"), { recursive: true });
    writeFileSync(
      join(directory, "src/integration/ooo-execution.ts"),
      candidate["src/integration/ooo-execution.ts"]!,
    );
    return "accept" as const;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const plan: ProbePlan = [
  ["P", "", [], "isolated-artifact", null, null],
  ["D", "4", ["P"], "read-only", null, "double"],
];

function fixture(t: TestContext, verify: PatchTaskSpec["verify"] = verifyRename) {
  const dir = mkdtempSync(join(tmpdir(), "ooo-cycle-"));
  const gate = new BoardAdmission(join(dir, "store.sqlite"), plan, {
    P: {
      instruction: "Rename byId to planIndex in nextTask only.",
      files: { "src/integration/ooo-execution.ts": source },
      editable: ["src/integration/ooo-execution.ts"],
      verify,
    },
  });
  t.after(() => {
    gate.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return gate;
}

function submitPatch(
  gate: BoardAdmission,
  ticket: { owner: string; patch?: { digest: string } },
  artifact: string,
) {
  const entry = gate.putTaskBoardEntry({
    taskId: "ooo-process-probe",
    agentId: ticket.owner,
    kind: "result",
    content: JSON.stringify({ ticket, artifact }),
    expiresAt: new Date(gate.now + 60_000).toISOString(),
  });
  return gate.submit(entry.id);
}

test("contract: a verified patch candidate is what dependents bind to, and only acceptance releases them", async (t) => {
  const gate = fixture(t);
  const ticket = gate.claim("P", "worker-p");
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.deepEqual(gate.accepted(), {});
  assert.equal(await submitPatch(gate, ticket, artifact), "accepted");
  assert.deepEqual(Object.keys(gate.accepted()), ["P"]);
  assert.deepEqual(JSON.parse(gate.accepted().P!), {
    kind: "patch",
    files: { "src/integration/ooo-execution.ts": expected },
  });
  const dependent = gate.claim("D", "worker-d");
  assert.deepEqual(dependent.dependencies, { P: gate.accepted().P! });
  const answer = String(Number(dependent.input) * 2);
  assert.equal(await submitPatch(gate, dependent, answer), "accepted");
  assert.deepEqual(Object.keys(gate.accepted()).sort(), ["D", "P"]);
});

test("acceptance lands on the board as a deliverable and an outside verdict, not a self-report", async (t) => {
  const gate = fixture(t);
  const ticket = gate.claim("P", "worker-p");
  const entryId = gate
    .readTaskBoard({ taskId: channel })
    .entries.find((entry) => entry.claimedBy === "worker-p")!.id;
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.equal(await submitPatch(gate, ticket, artifact), "accepted");

  // The round used to close this entry with resolveTaskBoardEntry(agentId:
  // "coordinator") — a self-report. What must be true now is that the artifact
  // is recorded against the claim that produced it and that someone other than
  // its producer judged it.
  const judged = gate.getTaskBoardEntryById(channel, entryId)!;
  assert.equal(judged.deliveredBy, "worker-p");
  assert.equal(judged.verdict, "accepted");
  assert.equal(judged.judgedBy, "coordinator");
  assert.notEqual(judged.judgedBy, judged.deliveredBy);
  assert.equal(judged.judgedDigest, judged.deliverableDigest);
  assert.notEqual(judged.deliverableDigest, null);
  assert.equal(judged.status, "resolved", "the lifecycle close still happens");
});

test("the board verdict is what accepts an artifact, not the round's own column", async (t) => {
  const gate = fixture(t);
  const ticket = gate.claim("P", "worker-p");
  const entryId = gate
    .readTaskBoard({ taskId: channel })
    .entries.find((entry) => entry.claimedBy === "worker-p")!.id;
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.equal(await submitPatch(gate, ticket, artifact), "accepted");
  assert.deepEqual(Object.keys(gate.accepted()), ["P"]);

  // The protocol lets an outside reviewer re-judge the delivered artifact. Acceptance
  // must follow the verdict, not the round's own row: the value is still stored there,
  // and it must stop counting as accepted.
  gate.judgeTaskBoardEntry({
    taskId: channel,
    entryId,
    agentId: "auditor",
    verdict: "rejected",
    reason: "re-tested and failed",
  });
  assert.deepEqual(gate.accepted(), {});
});

test("cancellation is announced on the board, not only in the round's own store", (t) => {
  const gate = fixture(t);
  gate.claim("P", "worker-p");
  gate.cancel("operator stopped the round");

  // The terminal decision has to be visible to agents that were not the caller, which is
  // what makes a cross-process cancel work at all.
  const announcement = gate
    .readTaskBoard({ taskId: channel, includeResolved: true })
    .entries.find(
      (entry) =>
        entry.kind === "decision" && entry.content.includes("cancel: operator stopped the round"),
    );
  assert.ok(announcement, "another agent must be able to see that the round ended");
  assert.equal(announcement.agentId, "coordinator");
  assert.equal(gate.cancelled(), "operator stopped the round");
});

test("safety: worker-supplied approval is ignored and a reissued attempt fences the old artifact", async (t) => {
  const gate = fixture(t, async () => "accept");
  const files = (content: string) => [{ path: "src/integration/ooo-execution.ts", content }];
  const first = gate.claim("P", "worker-p");
  // Extra fields are not a verdict channel: the artifact shape must be exact.
  const selfApproved = JSON.stringify({
    digest: first.patch!.digest,
    files: files(expected),
    passed: true,
    verdict: "accept",
  });
  assert.equal(await submitPatch(gate, first, selfApproved), "rejected");
  assert.deepEqual(gate.accepted(), {});
  // A rejected attempt keeps its claim: nothing is re-dispatched while it is live.
  assert.equal(gate.next(), null);

  gate.now += 61_000;
  const second = gate.claim("P", "worker-q");
  assert.equal(second.attempt, 2);
  assert.notEqual(second.patch!.digest, first.patch!.digest);
  const stale = JSON.stringify({ digest: first.patch!.digest, files: files(expected) });
  assert.equal(await submitPatch(gate, first, stale), "stale");
  const fresh = JSON.stringify({ digest: second.patch!.digest, files: files(expected) });
  assert.equal(await submitPatch(gate, second, fresh), "accepted");
  assert.equal(await submitPatch(gate, second, fresh), "duplicate");
});

test("safety: a rejected proposal never accepts worker text and the same attempt can correct it", async (t) => {
  const gate = fixture(t);
  const first = gate.claim("P", "worker-1");
  assert.equal(await submitPatch(gate, first, proposal()), "rejected");
  assert.equal(gate.next(), null);
  const corrected = JSON.stringify({
    digest: first.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.equal(await submitPatch(gate, first, corrected), "accepted");
  assert.equal(await submitPatch(gate, first, corrected), "duplicate");
  assert.deepEqual(JSON.parse(gate.accepted().P!), {
    kind: "patch",
    files: { "src/integration/ooo-execution.ts": expected },
  });
});

test("contract: a conclusion is admissible without files but cannot carry a change", async (t) => {
  const gate = fixture(t);
  const first = gate.claim("P", "worker-1");
  const digest = first.patch!.digest;
  const conclusion = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      digest,
      kind: "conclusion",
      conclusion: "no-change-needed",
      summary: "the frozen check already covers this case",
      evidence: "check-events.test.ts:12 passes on the frozen revision",
      citations: [{ case: "stale", test: "rejects a stale check" }],
      ...extra,
    });
  // A conclusion may not smuggle file content into the same submission.
  assert.equal(await submitPatch(gate, first, conclusion({ files: [expected] })), "rejected");
  assert.equal(await submitPatch(gate, first, conclusion({ summary: "" })), "rejected");
  assert.equal(await submitPatch(gate, first, conclusion()), "accepted");
  assert.deepEqual(JSON.parse(gate.accepted().P!), {
    kind: "conclusion",
    conclusion: "no-change-needed",
    summary: "the frozen check already covers this case",
    evidence: "check-events.test.ts:12 passes on the frozen revision",
    citations: [{ case: "stale", test: "rejects a stale check" }],
  });
  assert.equal(gate.next(), "D");
});

test("safety: a host check that throws or is undecidable cannot accept a candidate", async (t) => {
  const gate = fixture(t, async () => {
    throw new Error("check crashed");
  });
  const ticket = gate.claim("P", "worker-p");
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.equal(await submitPatch(gate, ticket, artifact), "rejected");
  assert.deepEqual(gate.accepted(), {});
});

test("an outside rejection withdraws the release of a dependent, and the round fails closed", async (t) => {
  const gate = fixture(t);
  const ticket = gate.claim("P", "worker-p");
  const entryId = gate
    .readTaskBoard({ taskId: channel })
    .entries.find((entry) => entry.claimedBy === "worker-p")!.id;
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.equal(await submitPatch(gate, ticket, artifact), "accepted");
  assert.equal(gate.next(), "D", "the dependent is selected while P's artifact is accepted");

  gate.judgeTaskBoardEntry({
    taskId: channel,
    entryId,
    agentId: "auditor",
    verdict: "rejected",
    reason: "re-tested and failed",
  });

  // One fact, one predicate: releasing D follows the verdict, not the stored value. The
  // round used to keep scheduling dependents on "the artifact column is not null", which
  // an outside reviewer cannot change — so a rejection it had already recorded was
  // invisible to the very path that decides what may be built on.
  assert.deepEqual(gate.accepted(), {});
  assert.equal(gate.next(), null, "nothing is selected on work that is no longer accepted");
  assert.throws(() => gate.claim("D", "worker-d"), /unfulfilled dependencies/u);
  // Failing closed, not self-healing: the rejected artifact is still delivered, so it is
  // not silently re-run either. Recovery is the coordinator's explicit reopen, because a
  // second attempt nobody decided on is exactly the self-approval the fence prevents.
  assert.throws(
    () => gate.claim("P", "worker-p2"),
    /delivered but not accepted; the coordinator must reopen it/u,
  );
  assert.deepEqual(gate.reopen("P", "auditor rejected the accepted artifact"), ["P"]);
  assert.equal(gate.next(), "P", "after reopen the task is schedulable again");
});

test("acceptance survives the entry's own TTL, because the round retains what it references", async (t) => {
  const gate = fixture(t);
  const ticket = gate.claim("P", "worker-p");
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.equal(await submitPatch(gate, ticket, artifact), "accepted");
  const entryId = gate
    .readTaskBoard({ taskId: channel, includeResolved: true })
    .entries.find((entry) => entry.deliveredBy === "worker-p")!.id;
  assert.ok(
    gate.listTaskBoardRetentions({ taskId: channel }).length > 0,
    "publishing a handoff pins it: the round references an entry whose own TTL is 24h",
  );

  // Far past every TTL in the store. The global prune still removes entries nobody
  // references (the round's own decision announcements), so the assertion is not a count:
  // it is that the entry this run derives from is still there and still says accepted.
  gate.pruneExpiredTaskBoardEntries("2099-01-01T00:00:00.000Z");
  assert.ok(
    gate.getTaskBoardEntryById(channel, entryId),
    "the referenced entry survives its own expiry",
  );
  assert.deepEqual(
    Object.keys(gate.accepted()),
    ["P"],
    "acceptance is re-derived from the retained verdict, not from a private column",
  );
  assert.equal(gate.next(), "D");

  // Once the value it protected is invalidated, the pin goes with it and the entry becomes
  // prunable again: retention defers the prune, it does not exempt the entry from it.
  gate.reopen("P", "the artifact is no longer wanted");
  assert.deepEqual(
    gate.listTaskBoardRetentions({ taskId: channel }).filter((row) => row.entryId === entryId),
    [],
    "the pin on the entry this verdict lived in is gone (D's own handoff pin is not P's business)",
  );
  gate.pruneExpiredTaskBoardEntries("2099-01-01T00:00:00.000Z");
  assert.equal(
    gate.getTaskBoardEntryById(channel, entryId),
    null,
    "with the pin gone the expired entry is finally pruned",
  );
});

test("cancelling a round releases the pins it held, so nothing it referenced leaks", async (t) => {
  const gate = fixture(t);
  const ticket = gate.claim("P", "worker-p");
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "src/integration/ooo-execution.ts", content: expected }],
  });
  assert.equal(await submitPatch(gate, ticket, artifact), "accepted");
  assert.ok(
    gate.listTaskBoardRetentions({ taskId: channel }).length > 0,
    "the round holds pins while it is running",
  );

  // Cancellation fences every row, and both kinds of pin go with the values they protected:
  // the handoff published for the successor, and the entry whose verdict accepted P. A
  // leaked pin would keep an entry alive forever in a round nobody is running.
  gate.cancel("operator stopped the round");
  assert.deepEqual(gate.listTaskBoardRetentions({ taskId: channel }), []);
});
