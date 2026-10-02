import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { dispatchPlan, type DispatchBoard } from "../../src/integration/ooo-dispatch.ts";
import { workDigest } from "../../src/integration/work-identity.ts";

/** The adopter owns numeric declaration/acceptance. The store sees only the existing board header. */
test("a numeric adopter uses the real board's lease, delivery and outside verdict without a patch declaration", async () => {
  const store = new NmgStore(":memory:");
  try {
    const channel = "numeric-adopter";
    const declaration = Object.freeze({
      digest: workDigest(JSON.stringify([2, 3])),
      values: Object.freeze([2, 3]),
    });
    const initial = store.putTaskBoardEntry({
      taskId: channel,
      agentId: "numeric-host",
      to: "numeric-worker",
      kind: "handoff",
      content: JSON.stringify(declaration),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const current = () => {
      const entry = store.getTaskBoardEntryById(channel, initial.id);
      assert.ok(entry);
      return entry;
    };
    const board: DispatchBoard<typeof declaration> = {
      channel,
      get now() {
        return Date.now();
      },
      candidates() {
        const entry = current();
        return entry.status === "open" && entry.claimedBy === null ? ["sum"] : [];
      },
      legality() {
        const legal = [...this.candidates()];
        return {
          legal,
          room: legal.length,
          units: [{ id: "sum", legal: legal.length > 0, reasons: [] }],
        };
      },
      accepted(): Readonly<Record<string, string>> {
        const entry = current();
        return entry.verdict === "accepted" &&
          entry.judgedDigest === entry.deliverableDigest &&
          entry.deliverableRef !== null
          ? { sum: entry.deliverableRef }
          : {};
      },
      claim(_taskId, owner) {
        assert.equal(
          current().content,
          JSON.stringify(declaration),
          "the adopter validates its declaration",
        );
        const entry = store.claimTaskBoardEntry({
          taskId: channel,
          entryId: initial.id,
          agentId: owner,
        });
        assert.ok(entry.attempt);
        return { attempt: entry.attempt, dependencies: {}, declaration };
      },
      putTaskBoardEntry(input) {
        const wire = JSON.parse(input.content) as { artifact: unknown };
        assert.equal(typeof wire.artifact, "string");
        const artifact = wire.artifact as string;
        const entry = store.deliverTaskBoardEntry({
          taskId: channel,
          entryId: initial.id,
          agentId: input.agentId,
          digest: workDigest(artifact),
          ref: artifact,
        });
        return { id: entry.id };
      },
      async submit(entryId) {
        const entry = current();
        assert.ok(entry.deliverableRef);
        const value = JSON.parse(entry.deliverableRef) as { digest: string; value: number };
        const verdict =
          value.digest === declaration.digest && value.value === 5 ? "accepted" : "rejected";
        store.judgeTaskBoardEntry({ taskId: channel, entryId, agentId: "numeric-judge", verdict });
        return verdict;
      },
    };
    const outcome = await dispatchPlan({
      board,
      plan: ["sum"],
      slots: 1,
      ownerOf: () => "numeric-worker",
      legality: () => ({ tasks: [], declarations: {} }),
      worker: async (_taskId, admitted) => {
        assert.equal(admitted, declaration);
        return JSON.stringify({
          digest: admitted.digest,
          value: admitted.values.reduce((a, b) => a + b, 0),
        });
      },
    });
    assert.deepEqual(outcome.failures, []);
    assert.deepEqual(outcome.slotRefusals, []);
    assert.equal(outcome.units[0]?.verdict, "accepted");
    assert.equal(current().deliveredBy, "numeric-worker");
    assert.equal(current().judgedBy, "numeric-judge");
    assert.notEqual(current().deliveredBy, current().judgedBy);
    assert.equal(current().judgedDigest, current().deliverableDigest);
    assert.deepEqual(Object.keys(outcome.accepted), ["sum"]);
    assert.equal(
      current().content,
      JSON.stringify(declaration),
      "the store did not turn the body into another work shape",
    );
  } finally {
    store.close();
  }
});
