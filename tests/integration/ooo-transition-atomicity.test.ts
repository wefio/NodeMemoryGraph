/**
 * A round's transition is one state change, so a board write inside it is part of it: either the
 * publication and the run facts land together, or neither does. The design's contract requires
 * that the composed write join the open transition through its port instead of opening a second
 * BEGIN, and these tests are what makes that checkable rather than a convention.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { BoardAdmission, type ProbePlan } from "../../src/integration/ooo-board.ts";

const plan: ProbePlan = [["A", "", [], "isolated-artifact", null, null]];

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-atomic-"));
  const database = join(directory, "round.sqlite");
  const gate = new BoardAdmission(database, plan, {}, { runId: "atomic-run" });
  t.after(() => {
    gate.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const published = (content: string): number => {
    const reader = new DatabaseSync(database, { readOnly: true });
    try {
      return (
        reader
          .prepare("SELECT COUNT(*) AS count FROM task_board_entries WHERE content = ?")
          .get(content) as { count: number }
      ).count;
    } finally {
      reader.close();
    }
  };
  /** The round's own publication path, which is private: this is the call the round makes. */
  const publish = (content: string, port: unknown): string =>
    (
      gate as unknown as { publish: (kind: string, content: string, port?: unknown) => string }
    ).publish("decision", content, port);
  return { gate, published, publish };
}

test("a board write inside a round transition commits with it", (t) => {
  const { gate, publish, published } = fixture(t);
  gate.writeTransaction((port) => {
    publish("committed with the transition", port);
  });
  assert.equal(published("committed with the transition"), 1);
});

test("the round's own publication rolls back with the transition that made it", (t) => {
  const { gate, publish, published } = fixture(t);
  assert.throws(
    () =>
      gate.writeTransaction((port) => {
        publish("rolled back with the transition", port);
        throw new Error("the transition failed after the publication");
      }),
    /the transition failed after the publication/u,
  );
  assert.equal(
    published("rolled back with the transition"),
    0,
    "a publication that opened its own transaction would have survived this",
  );
});

test("a publication without a port is refused inside a transition, not nested", (t) => {
  const { gate, publish, published } = fixture(t);
  assert.throws(
    () =>
      gate.writeTransaction(() => {
        publish("published the wrong way", undefined);
      }),
    /already open: join it with the port it issued/u,
  );
  assert.equal(published("published the wrong way"), 0);
});
