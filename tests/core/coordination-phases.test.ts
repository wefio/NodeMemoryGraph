import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgStore } from "../../src/core/store.ts";
import {
  executeCoordinationState,
  prepareCoordinationSurface,
} from "../../src/integration/coordination-state.ts";

test("phase transitions bind confirmations to a proposal and persist independently of notes", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-phases-"));
  const path = join(dir, "store.sqlite");
  const store = new NmgStore(path);
  try {
    const event = store.createCoordinationEvent({
      agentId: "a",
      title: "Shared design",
      participants: ["b"],
    });
    const child = store.createCoordinationEvent({
      agentId: "a",
      title: "Independent",
      parentId: event.id,
    });
    const update = (agentId: string, data: Record<string, unknown>) =>
      executeCoordinationState(store, "eventUpdate", {
        agentId,
        eventId: event.id,
        event: {
          expectedRevision: store.readCoordinationEvent(event.id).event.revision,
          text: "Coordinate phase",
          ...data,
        },
      });
    assert.equal("collaboration" in event, false);
    update("a", {
      kind: "phasePropose",
      proposalId: "p1",
      target: "execution",
      expectedPhaseRevision: 0,
    });
    assert.throws(
      () => update("a", { kind: "phaseSwitch", proposalId: "p1", expectedPhaseRevision: 0 }),
      /confirmation/i,
    );
    assert.throws(
      () => update("b", { kind: "phaseAgree", proposalId: "wrong", expectedPhaseRevision: 0 }),
      /proposal/i,
    );
    assert.throws(
      () => update("outsider", { kind: "phaseAgree", proposalId: "p1", expectedPhaseRevision: 0 }),
      /participants/,
    );
    update("a", { kind: "note" });
    assert.throws(
      () =>
        executeCoordinationState(store, "eventUpdate", {
          agentId: "b",
          eventId: event.id,
          event: {
            expectedRevision: 1,
            text: "Old snapshot",
            kind: "phaseAgree",
            proposalId: "p1",
            expectedPhaseRevision: 0,
          },
        }),
      /Event revision changed/,
    );
    update("b", { kind: "phaseAgree", proposalId: "p1", expectedPhaseRevision: 0 });
    const switched = update("b", {
      kind: "phaseSwitch",
      proposalId: "p1",
      expectedPhaseRevision: 0,
    });
    assert.match(prepareCoordinationSurface(switched).text, /phase=execution.*phaseRevision=1/);
    const directory = executeCoordinationState(store, "eventRead", { agentId: "a" });
    assert.match(prepareCoordinationSurface(directory).text, /phase=execution.*phaseRevision=1/);
    const notice = store
      .readDirectedTaskBoard({ agentId: "a", agentName: "a" })
      .find((item) => item.eventId === event.id);
    assert.match(notice?.content ?? "", /phase=execution phaseRevision=1/);
    const historyBeforeFailure = store.readCoordinationEvent(event.id).changes.length;
    assert.throws(
      () =>
        update("a", {
          kind: "phasePropose",
          proposalId: "stale",
          target: "discussion",
          expectedPhaseRevision: 0,
        }),
      /phase revision/i,
    );
    assert.equal("collaboration" in store.readCoordinationEvent(child.id).event, false);
    assert.equal(store.readCoordinationEvent(event.id).changes.length, historyBeforeFailure);
    const reopened = new NmgStore(path);
    try {
      assert.match(
        JSON.stringify(reopened.readCoordinationEvent(event.id).event),
        /"phaseRevision":1/,
      );
    } finally {
      reopened.close();
    }
    update("a", {
      kind: "phasePropose",
      proposalId: "p2",
      target: "discussion",
      expectedPhaseRevision: 1,
      requiredApprovers: ["a"],
    });
    assert.throws(
      () =>
        update("a", {
          kind: "phasePropose",
          proposalId: "p3",
          target: "discussion",
          expectedPhaseRevision: 1,
        }),
      /pending/i,
    );
    update("a", { kind: "phaseWithdraw", proposalId: "p2", expectedPhaseRevision: 1 });
    assert.throws(
      () =>
        update("a", {
          kind: "phasePropose",
          proposalId: "p2",
          target: "discussion",
          expectedPhaseRevision: 1,
        }),
      /already been used/,
    );
    assert.throws(
      () => update("b", { kind: "phaseAgree", proposalId: "p2", expectedPhaseRevision: 1 }),
      /proposal/i,
    );
    assert.throws(
      () =>
        update("a", {
          kind: "phasePropose",
          proposalId: "bad",
          target: "discussion",
          expectedPhaseRevision: 1,
          requiredApprovers: ["outsider"],
        }),
      /participants/i,
    );
    update("a", {
      kind: "phasePropose",
      proposalId: "solo",
      target: "discussion",
      expectedPhaseRevision: 1,
      requiredApprovers: ["a"],
    });
    update("a", { kind: "phaseSwitch", proposalId: "solo", expectedPhaseRevision: 1 });
    assert.equal(store.readCoordinationEvent(event.id).event.collaboration?.phase, "discussion");
    update("a", { kind: "close" });
    assert.throws(
      () =>
        update("a", {
          kind: "phasePropose",
          proposalId: "closed",
          target: "discussion",
          expectedPhaseRevision: 1,
        }),
      /reopen/i,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
