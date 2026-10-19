import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";
stripProviderEnv();

test("shared state exposes coarse event history beside world communication with direction fences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-event-api-"));
  const service = new NmgService({ dataDirectory: dir });
  const base = { space: "board", agentId: "a", taskId: "default" } as const;
  try {
    const created = await service.invoke("state", {
      ...base,
      action: "write",
      operation: "eventCreate",
      event: { title: "General feature discussion", participants: ["b"] },
    });
    assert.ok("event" in created.result && created.result.event);
    if (!("event" in created.result) || !created.result.event) throw Error("Missing event");
    const id = created.result.event.id;
    await service.invoke("state", {
      ...base,
      action: "write",
      operation: "put",
      kind: "note",
      content: "Ordinary message still works",
    });
    const world = await service.invoke("state", { ...base, action: "read" });
    assert.match(world.information!.text, /Ordinary message still works/);
    assert.match(world.information!.text, /General feature discussion/);
    await assert.rejects(
      service.invoke("state", {
        ...base,
        action: "read",
        operation: "eventUpdate",
        eventId: id,
        event: { expectedRevision: 1, kind: "close", text: "No read-side mutation" },
      }),
      /unsupported/,
    );
    await service.invoke("state", {
      ...base,
      action: "write",
      operation: "eventUpdate",
      eventId: id,
      event: { expectedRevision: 1, kind: "close", text: "Ended", outcome: "unknown" },
    });
    const read = await service.invoke("state", {
      ...base,
      action: "read",
      operation: "eventRead",
      eventId: id,
    });
    assert.match(read.information!.text, /Ended/);
    assert.match(read.information!.text, /r2/);
    assert.ok(read.information!.included.some((row) => row.source.kind === "event"));
    const inbox = await service.invoke("taskBoard", {
      action: "readInbox",
      agentId: "b",
      agentName: "b",
    });
    assert.equal(
      inbox.action === "readInbox" && inbox.entries.filter((entry) => entry.eventNotice).length,
      1,
    );
    assert.ok(inbox.action === "readInbox" && inbox.entries[0]?.eventRevision === 2);
    assert.ok("changes" in read.result);
    if ("changes" in read.result)
      assert.deepEqual(
        read.result.changes?.map((change) => change.revision),
        [1, 2],
      );
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
