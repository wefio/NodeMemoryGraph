import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import type { NodeRelation } from "../../src/core/types.ts";
import { linkNodePath } from "./node-graph-behavior.ts";

function existingNodes(store: NmgStore): [string, string, string] {
  const node = (name: string) =>
    store.remember({ nodeName: name, statement: `${name} exists` }).node.id;
  return [node("alpha"), node("beta"), node("gamma")];
}

test("linkNodePath writes adjacent pairs in order and returns the actual relation snapshots", (t) => {
  const store = new NmgStore(":memory:");
  t.after(() => store.close());
  const [a, b, c] = existingNodes(store);
  const path = Object.freeze([c, a, b]);
  const observed: NodeRelation[] = [];
  const writer: Parameters<typeof linkNodePath>[0] = {
    linkNodes(input) {
      const relation = store.linkNodes(input);
      observed.push(relation);
      return relation;
    },
  };

  const relations = linkNodePath(writer, path, "depends_on");

  assert.deepEqual(
    relations.map((relation) => [relation.sourceNodeId, relation.targetNodeId, relation.type]),
    [
      [c, a, "depends_on"],
      [a, b, "depends_on"],
    ],
  );
  assert.equal(observed.length, 2);
  assert.strictEqual(relations[0], observed[0]);
  assert.strictEqual(relations[1], observed[1]);
  const persisted = store.getRelations([a, b, c]);
  assert.equal(persisted.length, 2, "no implicit closing edge");
  for (const relation of relations) {
    assert.deepEqual(
      persisted.find((row) => row.id === relation.id),
      relation,
    );
  }
  assert.deepEqual(path, [c, a, b]);
});

test("linkNodePath preserves repeated endpoints and repeated edge results", (t) => {
  const store = new NmgStore(":memory:");
  t.after(() => store.close());
  const [a, b] = existingNodes(store);

  const relations = linkNodePath(store, [a, b, a, b], "causes");

  assert.deepEqual(
    relations.map((relation) => [relation.sourceNodeId, relation.targetNodeId]),
    [
      [a, b],
      [b, a],
      [a, b],
    ],
  );
  assert.equal(relations[2]!.id, relations[0]!.id, "the store's idempotent re-link result is kept");
  assert.equal(store.getRelations([a, b]).length, 2);
  assert.ok(
    store
      .detectGraphCycles()
      .relationCycles.some((cycle) => cycle.includes(a) && cycle.includes(b)),
    "the supplied return edge is not filtered as a DAG violation",
  );
});

test("linkNodePath performs no writes for an empty or singleton path", () => {
  let calls = 0;
  const writer: Parameters<typeof linkNodePath>[0] = {
    linkNodes() {
      calls += 1;
      throw new Error("there is no adjacent pair");
    },
  };

  assert.deepEqual(linkNodePath(writer, [], "causes"), []);
  assert.deepEqual(linkNodePath(writer, ["existing-node"], "causes"), []);
  assert.equal(calls, 0);
});

test("linkNodePath propagates a later link failure and leaves the successful prefix", (t) => {
  const store = new NmgStore(":memory:");
  t.after(() => store.close());
  const [a, b, c] = existingNodes(store);
  const failure = new Error("the second edge is refused");
  let calls = 0;
  const writer: Parameters<typeof linkNodePath>[0] = {
    linkNodes(input) {
      calls += 1;
      if (calls === 2) throw failure;
      return store.linkNodes(input);
    },
  };

  assert.throws(
    () => linkNodePath(writer, [a, b, c, a], "causes"),
    (error) => error === failure,
  );
  assert.equal(calls, 2, "execution stops at the failing edge");
  assert.deepEqual(
    store.getRelations([a, b, c]).map((relation) => [relation.sourceNodeId, relation.targetNodeId]),
    [[a, b]],
    "the first write remains and neither later edge is written",
  );
});
