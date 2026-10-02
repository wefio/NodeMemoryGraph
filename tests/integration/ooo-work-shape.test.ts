import assert from "node:assert/strict";
import test from "node:test";

import { dispatchPlan, type DispatchTicket } from "../../src/integration/ooo-dispatch.ts";
import { workDigest } from "../../src/integration/work-identity.ts";
import type { LegalityAnswer } from "../../src/integration/ooo-execution.ts";

/** A declaration the shared loop has never seen: numeric values, not source files. */
const VALUES = Object.freeze({
  digest: workDigest(JSON.stringify({ values: [2, 3] })),
  values: Object.freeze([2, 3]),
});

class ValueBoard {
  readonly channel = "value-run";
  readonly now = 1_700_000_000_000;
  claims = 0;
  #accepted: Record<string, string> = {};
  #artifact = "";
  #held = false;
  readonly shape: string;
  readonly declaration: typeof VALUES | null;
  constructor(shape = "numeric-values", declaration: typeof VALUES | null = VALUES) {
    this.shape = shape;
    this.declaration = declaration;
  }

  candidates(): readonly string[] {
    return this.#held || this.#accepted.sum !== undefined ? [] : ["sum"];
  }

  legality(): LegalityAnswer {
    const legal = [...this.candidates()];
    return {
      legal,
      room: this.#held ? 0 : 1,
      units: [{ id: "sum", legal: legal.includes("sum"), reasons: [] }],
    };
  }

  accepted(): Readonly<Record<string, string>> {
    return this.#accepted;
  }

  claim(_taskId: string, _owner: string) {
    // Shape interpretation and refusal belong to the adopter, before taking a lease.
    if (this.shape !== "numeric-values")
      return { refused: `unsupported work shape: ${this.shape}` };
    this.#held = true;
    this.claims++;
    return { attempt: 1, dependencies: {}, declaration: this.declaration };
  }

  putTaskBoardEntry(input: { content: string }): { id: string } {
    const entry = JSON.parse(input.content) as {
      artifact: string;
      ticket: { declaration: typeof VALUES };
    };
    assert.deepEqual(entry.ticket.declaration, VALUES, "the declaration is carried, not rewritten");
    this.#artifact = entry.artifact;
    return { id: "sum-result" };
  }

  async submit(_entryId: string): Promise<string> {
    const artifact = JSON.parse(this.#artifact) as { digest: string; value: number };
    if (artifact.digest !== VALUES.digest || artifact.value !== 5) return "rejected";
    this.#accepted.sum = this.#artifact;
    this.#held = false;
    return "accepted";
  }
}

test("the carrier is required, so a legacy optional-shape ticket cannot silently satisfy the port", () => {
  type LegacyTicket = { attempt: number; dependencies: Record<string, string> };
  const required: LegacyTicket extends DispatchTicket ? false : true = true;
  assert.equal(required, true);
});

test("an unseen numeric declaration runs through the shared loop without a patch envelope", async () => {
  const board = new ValueBoard();
  let called = 0;
  const outcome = await dispatchPlan({
    board,
    plan: ["sum"],
    slots: 1,
    legality: () => ({ tasks: [], declarations: {} }),
    ownerOf: () => "value-worker",
    worker: async (_taskId, declaration) => {
      called++;
      assert.equal(declaration, VALUES, "the loop does not reinterpret or freeze the payload");
      return JSON.stringify({
        digest: VALUES.digest,
        value: VALUES.values.reduce((a, b) => a + b, 0),
      });
    },
  });
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(outcome.order, ["sum"]);
  assert.equal(outcome.units[0]?.verdict, "accepted");
  assert.equal(called, 1);
  assert.equal(board.claims, 1);
});

test("an unknown shape is refused by name before claiming, not reported as a failed unit", async () => {
  const board = new ValueBoard("not-supported-v9");
  const outcome = await dispatchPlan({
    board,
    plan: ["sum"],
    slots: 1,
    legality: () => ({ tasks: [], declarations: {} }),
    ownerOf: () => "value-worker",
    worker: async () => {
      throw new Error("a refused declaration must never run a worker");
    },
  });
  assert.equal(board.claims, 0);
  assert.deepEqual(outcome.units, []);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(outcome.slotRefusals, ["unsupported work shape: not-supported-v9"]);
});
