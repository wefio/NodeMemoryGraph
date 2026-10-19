import assert from "node:assert/strict";
import test from "node:test";
import { NmgStore } from "../../src/core/store.ts";
import {
  executeCoordinationState,
  prepareCoordinationSurface,
} from "../../src/integration/coordination-state.ts";
function fixture(run: (store: NmgStore) => void) {
  const store = new NmgStore(":memory:");
  try {
    run(store);
  } finally {
    store.close();
  }
}

test("creation keeps initial relations when current event metadata evolves", () =>
  fixture((store) => {
    const event = store.createCoordinationEvent({
      agentId: "a",
      title: "Initial context",
      resources: ["original-resource"],
    });
    store.updateCoordinationEvent({
      eventId: event.id,
      agentId: "a",
      expectedRevision: 1,
      change: { kind: "relations", text: "Scope changed", resources: ["replacement-resource"] },
    });
    const read = store.readCoordinationEvent(event.id),
      creation = read.changes[0]!.payload;
    assert.equal(creation.kind, "created");
    if (creation.kind !== "created") throw Error("Missing creation context");
    assert.deepEqual(creation.record.resources, ["original-resource"]);
    assert.deepEqual(read.event.resources, ["replacement-resource"]);
  }));
test("oversized initial context is rejected before any event or history is persisted", () =>
  fixture((store) => {
    assert.throws(
      () =>
        store.createCoordinationEvent({
          agentId: "a",
          title: "Too large",
          resources: Array.from({ length: 32 }, (_, i) => `resource-${i}-` + "x".repeat(185)),
        }),
      /6000 characters/,
    );
    assert.equal(store.listCoordinationEvents().length, 0);
  }));
test("a large current snapshot does not make bounded historical changes unreadable", () =>
  fixture((store) => {
    const event = store.createCoordinationEvent({ agentId: "a", title: "Many channels" });
    for (let i = 0; i < 10; i++)
      store.updateCoordinationEvent({
        eventId: event.id,
        agentId: "a",
        expectedRevision: i + 1,
        change: {
          kind: "channel",
          text: `Channel ${i} opened`,
          channel: { channelId: `channel-${i}`, state: "active", summary: "x".repeat(1000) },
        },
      });
    const result = executeCoordinationState(store, "eventRead", {
      action: "read",
      agentId: "a",
      eventId: event.id,
      limit: 1,
      event: { afterRevision: 1, historyOnly: true },
    });
    const prepared = prepareCoordinationSurface(result);
    assert.equal(prepared.omitted.length, 0);
    assert.match(prepared.text, /Channel 0 opened/);
    assert.match(prepared.text, /nextRevision=2/);
    assert.ok(
      prepared.included.some(
        (entry) =>
          entry.source.kind === "event" &&
          entry.source.part === "change" &&
          entry.source.revision === 2,
      ),
    );
  }));
