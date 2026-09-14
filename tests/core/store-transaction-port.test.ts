/**
 * The store owns the transaction boundary (docs/design/task-unit-semantics.md, "事务参与与连接生命周期").
 * A round does not open its own transaction: it joins one synchronous state transition through the
 * port the store issued for it. These tests are about the refusals, because that is where the
 * contract can be broken silently: a second BEGIN, a port from somewhere else, a port used after
 * its callback returned, a callback that keeps the transaction open across an await, and a failure
 * the caller swallows while the transaction is already half written.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import type { TransactionPort } from "../../src/core/store/base.ts";

function withStore(t: TestContext, run: (store: NmgStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nmg-port-"));
  const store = new NmgStore(join(dir, "nmg.sqlite"));
  t.after(() => {
    try {
      store.close();
    } catch {
      // One test closes the connection itself, to make ROLLBACK fail. That is its subject.
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  run(store);
}

const entry = (content: string) => ({
  taskId: "port-channel",
  agentId: "worker-1",
  kind: "note" as const,
  content,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

const contents = (store: NmgStore): string[] =>
  store
    .readTaskBoard({ taskId: "port-channel", includeResolved: true })
    .entries.map((row) => row.content)
    .sort();

test("the store commits what a transition wrote and returns its value", (t) => {
  withStore(t, (store) => {
    const returned = store.writeTransaction((port) => {
      const row = store.putTaskBoardEntry(entry("written through the port"), port);
      return row.id;
    });
    assert.equal(typeof returned, "string");
    assert.deepEqual(contents(store), ["written through the port"]);
  });
});

test("a write entry reached inside a transition without a port is refused, not nested", (t) => {
  withStore(t, (store) => {
    assert.throws(
      () =>
        store.writeTransaction(() => {
          // This is the mistake the contract exists for: the same call that works on its own
          // would otherwise run a second BEGIN inside the first.
          store.putTaskBoardEntry(entry("nested"));
        }),
      /already open: join it with the port it issued/u,
    );
    assert.deepEqual(contents(store), [], "the refused write left nothing behind");
  });
});

test("a transition may not open another transition of its own", (t) => {
  withStore(t, (store) => {
    assert.throws(
      () => store.writeTransaction(() => store.writeTransaction(() => 1)),
      /already open/u,
    );
  });
});

test("a port from another store is refused", (t) => {
  withStore(t, (first) => {
    const dir = mkdtempSync(join(tmpdir(), "nmg-port-other-"));
    const second = new NmgStore(join(dir, "nmg.sqlite"));
    t.after(() => {
      second.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    first.writeTransaction((port: TransactionPort) => {
      assert.throws(
        () => second.withPort(port, () => 1),
        /not the store's live transaction scope/u,
      );
    });
  });
});

test("a port used after its callback returned is refused", (t) => {
  withStore(t, (store) => {
    let escaped: TransactionPort | null = null;
    store.writeTransaction((port) => {
      escaped = port;
      return 1;
    });
    assert.notEqual(escaped, null);
    assert.throws(
      () => store.withPort(escaped!, () => 1),
      /not the store's live transaction scope/u,
    );
    assert.throws(
      () => store.putTaskBoardEntry(entry("late"), escaped!),
      /not the store's live transaction scope/u,
    );
    assert.deepEqual(contents(store), []);
  });
});

test("a callback that would hold the transaction open across an await is refused", (t) => {
  withStore(t, (store) => {
    assert.throws(
      () =>
        store.writeTransaction(() => {
          store.putTaskBoardEntry(entry("async"), undefined);
          return Promise.resolve(1);
        }),
      /already open/u,
    );
    assert.throws(() => store.writeTransaction(() => Promise.resolve(1)), /must be synchronous/u);
    assert.deepEqual(contents(store), [], "nothing half written survives the refusal");
  });
});

test("a failure the caller swallows still forbids the commit", (t) => {
  withStore(t, (store) => {
    assert.throws(
      () =>
        store.writeTransaction((port) => {
          store.putTaskBoardEntry(entry("first"), port);
          try {
            store.withPort(port, () => {
              throw new Error("the second write failed");
            });
          } catch {
            // The caller decides to carry on. The transaction does not: the first write already
            // happened and the outermost is the only one that may decide to keep it.
          }
          return "carried on";
        }),
      /rollback-only/u,
    );
    assert.deepEqual(contents(store), [], "a caught failure does not become a commit");
  });
});

test("a failed rollback quarantines the connection instead of pretending it is usable", (t) => {
  withStore(t, (store) => {
    const raw = store as unknown as { db: DatabaseSync };
    assert.throws(
      () =>
        store.writeTransaction(() => {
          raw.db.close();
          throw new Error("the connection is gone");
        }),
      /the connection is gone/u,
    );
    assert.throws(
      () => store.writeTransaction(() => 1),
      /quarantined/u,
      "the store must not accept work on a connection whose state is unknown",
    );
  });
});

test("the store runs its transaction boundary in exactly one place", () => {
  // A mechanical check rather than a reminder: a hand-rolled BEGIN reappearing anywhere in the
  // store is what makes a second boundary possible, and no behavioural test notices a path that
  // still works by accident.
  const source = readFileSync(new URL("../../src/core/store/base.ts", import.meta.url), "utf8");
  const count = (needle: string) => source.split(needle).length - 1;
  assert.equal(count("BEGIN IMMEDIATE"), 1, "one BEGIN, in writeTransaction");
  assert.equal(count('"COMMIT"'), 1, "one COMMIT, in writeTransaction");
  assert.equal(count('"ROLLBACK"'), 1, "one ROLLBACK, in writeTransaction");
  const owned = source.slice(source.indexOf("writeTransaction<T>"), source.indexOf("withPort<T>"));
  assert.equal(owned.includes("BEGIN IMMEDIATE"), true, "the BEGIN belongs to writeTransaction");
  assert.equal(owned.includes('"COMMIT"'), true, "and so does the COMMIT");
  // The one ROLLBACK lives in the store's own helper, which only the boundary calls.
  assert.equal(
    owned.split("this.rollback()").length - 1,
    count("this.rollback()"),
    "every rollback call is one the boundary made",
  );
});
