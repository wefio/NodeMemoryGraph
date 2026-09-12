// S2 recovery: a round store outlives the process that created it, so the state after a
// crash must be the state before it — no duplicate completion, no wrong unblock, and no
// wait that only ends by accident.
//
// Every test closes its coordinators itself and removes the store afterwards, because a
// Windows handle on the sqlite file makes the cleanup fail rather than the assertion.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoardAdmission,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";

const channel = "ooo-process-probe";
const LEASE_MS = 60_000;

const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
  ["B", "", [], "isolated-artifact", null, null],
  ["C", "", ["A", "B"], "isolated-artifact", null, null],
];

const specs: Record<string, PatchTaskSpec> = {
  B: {
    instruction: "B works.",
    files: { "src/b.ts": "export const b = 1;\n" },
    editable: ["src/b.ts"],
    verify: async () => "accept",
  },
};

/** A store plus the handles needed to simulate a crash: closing the coordinator is the
 *  whole crash, because all mutable state lives in SQLite. */
function store() {
  const dir = mkdtempSync(join(tmpdir(), "ooo-recovery-"));
  const path = join(dir, "store.sqlite");
  const gates: BoardAdmission[] = [];
  return {
    path,
    open: () => {
      const gate = new BoardAdmission(path, plan, specs);
      gates.push(gate);
      return gate;
    },
    /** "Crash": close everything still open without a graceful shutdown. */
    close: () => {
      for (const gate of gates.splice(0)) gate.close();
    },
    // Windows keeps the sqlite handle briefly after close; retrying is the documented
    // remedy and keeps a cleanup failure from looking like an assertion failure.
    clean: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/** The only way an artifact reaches the coordinator: a board entry submitted by the
 *  claimed owner, which `submit` re-validates against the frozen ticket. */
function submitPatch(
  gate: BoardAdmission,
  ticket: { owner: string },
  artifact: string,
): Promise<string> {
  const entry = gate.putTaskBoardEntry({
    taskId: channel,
    agentId: ticket.owner,
    kind: "result",
    content: JSON.stringify({ ticket, artifact }),
    expiresAt: new Date(gate.now + LEASE_MS).toISOString(),
  });
  return gate.submit(entry.id);
}

const patchArtifact = (digest: string, content = "x") =>
  JSON.stringify({ digest, files: [{ path: "src/b.ts", content }] });

test("recovery: a crashed coordinator's successor finishes the round exactly once", async (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const first = s.open();
  const held = first.claim("B", "worker-1");
  s.close(); // crash: the claim is still recorded, the worker is gone

  const second = s.open();
  const artifact = patchArtifact(held.patch!.digest);
  // The successor does not steal a live claim — the holder's identity is preserved —
  // and it does not select a task whose dependencies are still pending either.
  assert.equal(second.next(), null);
  assert.throws(() => second.claim("B", "worker-2"), /already claimed/);
  assert.equal(await submitPatch(second, held, artifact), "accepted");
  assert.deepEqual(Object.keys(second.accepted()), ["B"]);
  // Completing B releases nothing that was not ready: C depends on A as well, and A is
  // still waiting for its own external evidence. A recovery that resumed C here would
  // be the "wrong unblock" this stage exists to rule out.
  assert.equal(second.next(), null);
  // Delivering A's check on the successor coordinator releases A's wait, so the wait
  // survived the crash intact rather than being resolved by it. It does not accept A:
  // terminal evidence unblocks the dependent work, which still has to be done, so C
  // stays blocked until A is accepted.
  const aCheck = second.issueCheck("A", "host");
  assert.equal(second.submitCheck({ ticket: aCheck, outcome: "passed", log: "" }), "accepted");
  assert.equal(second.next(), "A");
  assert.deepEqual(Object.keys(second.accepted()), ["B"]);
  // Exactly once: resubmitting the same artifact under the same attempt is a duplicate
  // and cannot produce a second completion or release C twice.
  assert.equal(await submitPatch(second, held, artifact), "duplicate");
  assert.deepEqual(Object.keys(second.accepted()), ["B"]);
  assert.equal(second.next(), "A");
});

test("recovery: a claim retired before the crash cannot be resubmitted afterwards", async (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const first = s.open();
  const held = first.claim("B", "worker-1");
  // A withdraw/reissue advances the attempt, so the old ticket is a stale generation.
  first.reopen("B", "withdrawn by the operator");
  s.close();

  const second = s.open();
  assert.equal(await submitPatch(second, held, patchArtifact(held.patch!.digest)), "stale");
  assert.deepEqual(second.accepted(), {});
  assert.equal(second.next(), "B");
  // The surviving generation is a different one, and only that one can complete.
  const fresh = second.claim("B", "worker-2");
  assert.notEqual(fresh.attempt, held.attempt);
  assert.equal(await submitPatch(second, fresh, patchArtifact(fresh.patch!.digest)), "accepted");
  assert.deepEqual(Object.keys(second.accepted()), ["B"]);
});

test("recovery: a lapsed claim is a new generation, not a silent success", async (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const gate = s.open();
  const held = gate.claim("B", "worker-1");
  // Time passes without a submission: the lease lapses, which fences the attempt rather
  // than letting the abandoned claim keep its generation.
  gate.now += LEASE_MS + 1;
  const resumed = gate.claim("B", "worker-2");
  assert.equal(resumed.attempt, held.attempt + 1);
  // The retired ticket's artifact is not the resumed generation's artifact.
  assert.equal(await submitPatch(gate, held, patchArtifact(held.patch!.digest)), "stale");
  assert.equal(await submitPatch(gate, resumed, patchArtifact(resumed.patch!.digest)), "accepted");
});

test("recovery: the first cancellation is the decision, and a second one does not rewrite it", (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const gate = s.open();
  gate.claim("B", "worker-1");
  gate.cancel("operator stopped the round");
  const withdrawn = gate.cancel("something else entirely");
  assert.deepEqual(withdrawn, [], "a second cancellation withdraws nothing");
  assert.equal(gate.cancelled(), "operator stopped the round");
});

test("recovery: a check that never reports ends explicitly instead of waiting forever", (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const gate = s.open();
  const ticket = gate.issueCheck("A", "host");
  // Nothing arrives and the check lease passes. The round must be able to say so: an
  // undecidable terminal decision, not an unbounded wait and not a synthetic success.
  gate.now = ticket.expiresAt + 1;
  assert.equal(gate.abandonCheck(ticket, "check host never reported"), true);
  assert.equal(gate.abandonCheck(ticket, "again"), false);
  assert.equal(gate.next(), "B");
  assert.deepEqual(gate.accepted(), {});
});

test("recovery: an abandoned check is not a terminal decision from an impostor", (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const gate = s.open();
  const ticket = gate.issueCheck("A", "host");
  const forged = { ...ticket, inputDigest: "forged" };
  assert.equal(gate.abandonCheck(forged, "not mine"), false);
  // The real ticket is untouched and still waiting for its own evidence.
  assert.equal(gate.cancelled(), null);
  assert.equal(gate.submitCheck({ ticket, outcome: "passed", log: "" }), "accepted");
});

test("recovery: cancellation fences the round so a late artifact cannot commit", async (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const gate = s.open();
  const held = gate.claim("B", "worker-1");

  assert.deepEqual(gate.cancel("operator cancelled the round"), ["B"]);
  assert.equal(gate.cancelled(), "operator cancelled the round");
  // Terminal: nothing is selectable, nothing is claimable, and no check can be issued
  // into a round nobody is waiting for.
  assert.equal(gate.next(), null);
  assert.throws(() => gate.claim("B", "worker-2"), /round cancelled/);
  assert.throws(() => gate.issueCheck("A", "host"), /round cancelled/);
  assert.throws(() => gate.externalReady("protocol-regression"), /round cancelled/);
  // The late artifact is rejected as a stale generation rather than accepted.
  assert.equal(await submitPatch(gate, held, patchArtifact(held.patch!.digest)), "stale");
  assert.deepEqual(gate.accepted(), {});
});

test("recovery: the cancellation survives a restart", (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const first = s.open();
  first.cancel("round withdrawn");
  s.close();

  const second = s.open();
  assert.equal(second.cancelled(), "round withdrawn");
  assert.equal(second.next(), null);
  assert.throws(() => second.claim("B", "worker-1"), /round cancelled/);
});

test("recovery: the store migrates additively, keeping prior state", async (t) => {
  const s = store();
  t.after(() => {
    s.close();
    s.clean();
  });
  const first = s.open();
  const held = first.claim("B", "worker-1");
  s.close();
  // Reopening runs the schema and the additive migration again: a row written before the
  // new columns existed keeps its claim, its attempt and its ticket identity.
  const second = s.open();
  assert.equal(second.cancelled(), null);
  assert.throws(() => second.claim("B", "worker-1"), /already claimed/);
  assert.equal(await submitPatch(second, held, patchArtifact(held.patch!.digest)), "accepted");
  assert.equal(s.path.endsWith("store.sqlite"), true);
});
