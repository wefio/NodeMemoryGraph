import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import type { NmgMethod } from "../../src/cli/protocol.ts";
import { collectWakeCandidates } from "../../src/integration/board-wake.ts";
import {
  enqueueBoardWakeBatch,
  recordBoardWakeBatchDelivery,
} from "../../src/integration/board-wake-batch.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();
test("shared board controls busy gating, phase races, and atomic source-bound receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-board-batch-api-"));
  const path = join(dir, "fixture.sqlite");
  const service = new NmgService({ databasePath: path, environment: {} });
  const db = new DatabaseSync(path);
  const identity = { agentId: "receiver", agentName: "receiver", sessionId: "s" };
  const invoke = (method: string, params: unknown) => service.invoke(method as NmgMethod, params);
  const activity = (state: string) =>
    invoke("state", {
      space: "board",
      action: "write",
      operation: "agentActivity",
      ...identity,
      activity: { state },
    });
  let sends = 0;
  try {
    await invoke("taskBoard", { action: "subscribe", taskId: "channel", ...identity });
    const created = await service.invoke("state", {
      space: "board",
      action: "write",
      operation: "eventCreate",
      agentId: identity.agentId,
      event: { title: "Batch phase" },
    });
    if (!("event" in created.result) || !created.result.event) throw Error("Missing event");
    const eventId = created.result.event.id;
    for (let i = 0; i < 8; i++)
      await invoke("taskBoard", {
        action: "put",
        taskId: "channel",
        agentId: `peer-${i}`,
        kind: "note",
        content: `Reply ${i}`,
        eventId,
      });
    const entries = await collectWakeCandidates(invoke, identity);
    assert.equal(entries.length, 8);
    const input = {
      invoke,
      entries,
      ...identity,
      dataDir: dir,
      sendWake: async () => {
        sends++;
      },
    };
    await activity("busy");
    assert.deepEqual(await enqueueBoardWakeBatch(input), []);
    assert.equal(sends, 0);
    await activity("idle");
    let reads = 0;
    const racing = async (method: string, params: unknown) => {
      const p = params as { operation?: string };
      if (p.operation === "eventRead" && ++reads === 2) {
        await invoke("state", {
          space: "board",
          action: "write",
          operation: "eventUpdate",
          agentId: identity.agentId,
          eventId,
          event: {
            expectedRevision: 1,
            kind: "phasePropose",
            proposalId: "start",
            expectedPhaseRevision: 0,
            target: "execution",
            text: "Begin",
          },
        });
        await invoke("state", {
          space: "board",
          action: "write",
          operation: "eventUpdate",
          agentId: identity.agentId,
          eventId,
          event: {
            expectedRevision: 2,
            kind: "phaseSwitch",
            proposalId: "start",
            expectedPhaseRevision: 0,
            text: "Commit",
          },
        });
      }
      return invoke(method, params);
    };
    await assert.rejects(enqueueBoardWakeBatch({ ...input, invoke: racing }), /phase changed/);
    assert.equal(sends, 0);
    db.exec(`CREATE TRIGGER reject_batch_receipt BEFORE INSERT ON task_board_deliveries
      WHEN NEW.entry_id='${entries[1]!.id}' BEGIN SELECT RAISE(ABORT,'receipt failed'); END;`);
    await assert.rejects(
      recordBoardWakeBatchDelivery(invoke, entries, identity.agentId, identity.sessionId),
      /receipt failed/,
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM task_board_deliveries").get()!.count, 0);
    db.exec("DROP TRIGGER reject_batch_receipt");
    const accepted = await enqueueBoardWakeBatch(input);
    assert.equal(accepted.length, 8);
    assert.equal(sends, 1);
    assert.deepEqual(await collectWakeCandidates(invoke, identity), []);
    await assert.rejects(
      invoke("taskBoard", { action: "recordDelivery", ...identity, entryIds: [] }),
      /entryIds/,
    );
    await assert.rejects(
      invoke("taskBoard", {
        action: "recordDelivery",
        ...identity,
        entryId: entries[0]!.id,
        entryIds: [entries[0]!.id],
      }),
      /entryId/,
    );
  } finally {
    db.close();
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
