import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { RecallBudget } from "../../src/integration/recall-budget.ts";
import { searchMemoryContext } from "../../src/integration/search.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an automatic embedding deadline returns lexical hits and ignores a late vector", async (t) => {
  const store = new NmgStore(":memory:");
  const vector = deferred<number[][]>();
  t.mock.method(store, "embeddingIndexHealth", () => ({ targets: ["records"] }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const budget = new RecallBudget(25);
  try {
    const memory = store.remember({
      statement: "Atlas SQLite offline storage",
      nodeName: "Atlas",
    }).memory;
    const pending = searchMemoryContext(
      store,
      { indexId: "test", embedQueries: () => vector.promise },
      "Atlas SQLite offline storage",
      { limit: 5 },
      undefined,
      budget,
    );
    t.mock.timers.tick(25);
    const context = await pending;
    assert.equal(context.results[0]?.memory.id, memory.id);
    assert.deepEqual(context.retrieval, {
      mode: "lexical",
      degraded: true,
      reason: "automatic_recall_embedding_deadline",
    });
    const trace = context.activeGraph?.id;
    vector.resolve([[1, 0]]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      context.activeGraph?.id,
      trace,
      "late semantic data does not replace the returned graph",
    );
  } finally {
    budget.close();
    store.close();
  }
});

test("an explicit search still waits for its query vector without the automatic deadline", async (t) => {
  const store = new NmgStore(":memory:");
  const vector = deferred<number[][]>();
  t.mock.method(store, "embeddingIndexHealth", () => ({ targets: ["records"] }));
  try {
    let answered = false;
    const pending = searchMemoryContext(
      store,
      { indexId: "test", embedQueries: () => vector.promise },
      "Atlas",
      { limit: 5 },
    ).then((context) => {
      answered = true;
      return context;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(answered, false);
    vector.resolve([[1, 0]]);
    assert.equal((await pending).retrieval?.mode, "hybrid");
  } finally {
    store.close();
  }
});

test("several automatic phases share one deadline and close releases its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const budget = new RecallBudget(50);
  try {
    const first = deferred<string>();
    const stage = budget.run("first", () => first.promise);
    t.mock.timers.tick(30);
    first.resolve("timely");
    assert.equal(await stage, "timely");
    const second = budget.run("second", () => new Promise<string>(() => undefined));
    t.mock.timers.tick(20);
    await assert.rejects(second, /total budget/u);
    assert.deepEqual(
      budget.stages.map(({ phase, outcome }) => [phase, outcome]),
      [
        ["first", "completed"],
        ["second", "timeout"],
      ],
    );
    await assert.rejects(
      budget.run("late", async () => "late"),
      /total budget/u,
    );
  } finally {
    budget.close();
  }
});
