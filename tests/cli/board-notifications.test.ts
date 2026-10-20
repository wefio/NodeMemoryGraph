import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { isBoardWakeCandidate } from "../../src/integration/board-wake.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";
stripProviderEnv();

async function fixture(run: (service: NmgService) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "nmg-board-notification-"));
  const service = new NmgService({ dataDirectory: dir });
  try {
    await run(service);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
async function post(
  service: NmgService,
  actor: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const result = await service.invoke("taskBoard", {
    action: "put",
    taskId: "discussion",
    agentId: actor,
    kind: "note",
    content,
    ...extra,
  });
  assert.equal(result.action, "put");
  if (result.action !== "put") throw Error("Missing posted entry");
  return result.entry;
}
async function inbox(service: NmgService, actor: string) {
  const result = await service.invoke("taskBoard", {
    action: "readInbox",
    agentId: actor,
    agentName: actor,
  });
  if (result.action !== "readInbox") throw Error("Missing inbox");
  return result.entries;
}
async function subscriptions(service: NmgService, actor: string) {
  const result = await service.invoke("taskBoard", {
    action: "listSubscriptions",
    agentId: actor,
    sessionId: `${actor}-session`,
  });
  if (result.action !== "listSubscriptions") throw Error("Missing subscriptions");
  return result.subscriptions.map((s) => s.taskId);
}
const invite = { key: "invite-1", scopes: ["direct"], recipients: ["b"], invite: true };

test("invitation reaches an unsubscribed invitee, enrolls both discussion parties and never accepts work", async () =>
  fixture(async (service) => {
    const original = await post(service, "a", "Please compare the two options here", {
      notification: invite,
    });
    const entries = await inbox(service, "b");
    assert.equal(entries.length, 1, "first invitation must not require prior channel membership");
    const notice = entries[0]!;
    assert.match(notice.content, /compare the two options/);
    assert.equal(notice.notificationSourceId, original.id);
    assert.equal(notice.notificationChannelId, "discussion");
    assert.equal(notice.invitation, true);
    assert.equal(
      isBoardWakeCandidate({ ...notice, sequence: 0 }, { agentId: "b", sessionId: "b-session" }),
      true,
    );
    assert.deepEqual(await subscriptions(service, "b"), ["discussion"]);
    assert.deepEqual(await subscriptions(service, "a"), ["discussion"]);
    const status = await service.invoke("state", {
      action: "read",
      space: "board",
      operation: "agentStatus",
      agentId: "b",
    });
    assert.ok("agentStatus" in status.result);
    if ("agentStatus" in status.result) assert.equal(status.result.agentStatus?.activity, "idle");
    await assert.rejects(
      service.invoke("taskBoard", {
        action: "claim",
        taskId: notice.taskId,
        entryId: notice.id,
        agentId: "b",
      }),
      /not claimable/,
    );
  }));

test("invitation retry is idempotent, conflicting reuse rejected, and a later opt-out cannot be undone by replay", async () =>
  fixture(async (service) => {
    const first = await post(service, "a", "Join this discussion", { notification: invite });
    assert.equal(
      (await post(service, "a", "Join this discussion", { notification: invite })).id,
      first.id,
    );
    const queued = (await inbox(service, "b"))[0]!;
    await service.invoke("taskBoard", {
      action: "unsubscribe",
      agentId: "b",
      sessionId: "b-session",
      taskId: "discussion",
    });
    await post(service, "a", "Join this discussion", { notification: invite });
    assert.deepEqual(await subscriptions(service, "b"), []);
    const check = await service.invoke("taskBoard", {
      action: "deliveryCheck",
      agentId: "b",
      sessionId: "b-session",
      taskId: queued.taskId,
      entryIds: [queued.id],
    });
    assert.ok(check.action === "deliveryCheck" && check.inactive?.includes(queued.id));
    await assert.rejects(
      post(service, "a", "Different invitation", { notification: invite }),
      /key.*different|different.*key/i,
    );
    await post(service, "a", "A genuinely new invitation", {
      notification: { ...invite, key: "invite-2" },
    });
    assert.deepEqual(await subscriptions(service, "b"), ["discussion"]);
    const stale = await service.invoke("taskBoard", {
      action: "deliveryCheck",
      agentId: "b",
      sessionId: "b-session",
      taskId: queued.taskId,
      entryIds: [queued.id],
    });
    assert.ok(
      stale.action === "deliveryCheck" && stale.inactive?.includes(queued.id),
      "rejoining must not resurrect the old invitation",
    );
  }));

test("channel follow-ups reach channel subscribers, not every event subscriber; ACK is silent", async () =>
  fixture(async (service) => {
    const created = await service.invoke("state", {
      action: "write",
      space: "board",
      operation: "eventCreate",
      agentId: "a",
      event: { title: "Feature", participants: ["b", "c"] },
    });
    if (!("event" in created.result) || !created.result.event) throw Error("Missing event");
    const eventId = created.result.event.id;
    await post(service, "a", "Invite only b", { eventId, notification: invite });
    const followup = await post(service, "b", "Here is the first alternative", { eventId });
    assert.equal(followup.eventId, eventId, "service must preserve optional event association");
    assert.ok((await inbox(service, "a")).some((e) => e.notificationSourceId === followup.id));
    assert.ok(!(await inbox(service, "c")).some((e) => e.notificationSourceId === followup.id));
    const before = (await inbox(service, "b")).map((e) => e.id);
    const notice = (await inbox(service, "a")).find((e) => e.notificationSourceId === followup.id)!;
    await service.invoke("taskBoard", {
      action: "acknowledge",
      agentId: "a",
      taskId: notice.taskId,
      entryId: notice.id,
    });
    assert.deepEqual(
      (await inbox(service, "b")).map((e) => e.id),
      before,
    );
    const unrelated = await post(service, "a", "Context only", { taskId: "other", eventId });
    assert.ok(!(await inbox(service, "c")).some((e) => e.notificationSourceId === unrelated.id));
  }));

test("event invitation selects current subscribers, excludes opt-outs and does not enroll future event subscribers", async () =>
  fixture(async (service) => {
    const created = await service.invoke("state", {
      action: "write",
      space: "board",
      operation: "eventCreate",
      agentId: "a",
      event: { title: "Feature", participants: ["b", "c"] },
    });
    if (!("event" in created.result) || !created.result.event) throw Error("Missing event");
    const eventId = created.result.event.id;
    await service.invoke("state", {
      action: "write",
      space: "board",
      operation: "eventUnsubscribe",
      agentId: "c",
      eventId,
    });
    const original = await post(service, "a", "Discuss this event here", {
      eventId,
      notification: {
        key: "event-invite",
        scopes: ["direct", "event"],
        recipients: ["b"],
        invite: true,
      },
    });
    assert.equal(
      (await inbox(service, "b")).filter((e) => e.notificationSourceId === original.id).length,
      1,
      "overlapping audiences must deduplicate",
    );
    assert.deepEqual(await subscriptions(service, "c"), []);
    await service.invoke("state", {
      action: "write",
      space: "board",
      operation: "eventSubscribe",
      agentId: "late",
      eventId,
    });
    assert.deepEqual(await subscriptions(service, "late"), []);
  }));

test("unread channel reminders coalesce, preserve source messages and do not create a wake-chain cap", async () =>
  fixture(async (service) => {
    await post(service, "a", "Join", { notification: invite });
    await post(service, "a", "First update");
    const newest = await post(service, "a", "Second update");
    const pending = (await inbox(service, "b")).filter(
      (e) => e.notificationSourceId && !e.invitation,
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.notificationSourceId, newest.id);
    for (let i = 0; i < 40; i++) {
      const entry = await post(service, "a", `Real discussion round ${i}`);
      const notice = (await inbox(service, "b")).find((e) => e.notificationSourceId === entry.id)!;
      assert.ok(notice, `round ${i} must not hit a new chain quota`);
      await service.invoke("taskBoard", {
        action: "recordDelivery",
        agentId: "b",
        sessionId: "b-session",
        entryId: notice.id,
        source: "wake",
      });
    }
    const source = await service.invoke("taskBoard", {
      action: "read",
      agentId: "b",
      taskId: "discussion",
      limit: 100,
    });
    assert.ok(source.action === "read" && source.entries.length === 43);
  }));

test("malformed notification fails before posting or enrolling recipients", async () =>
  fixture(async (service) => {
    await assert.rejects(
      post(service, "a", "Bad", { notification: { key: "bad", scopes: ["event"], invite: true } }),
      /eventId/,
    );
    await assert.rejects(
      post(service, "a", "Bad", {
        notification: { key: "bad", scopes: ["direct"], recipients: ["b"], invite: "yes" },
      }),
      /invite/,
    );
    assert.deepEqual(await subscriptions(service, "b"), []);
    const read = await service.invoke("taskBoard", {
      action: "read",
      agentId: "a",
      taskId: "discussion",
    });
    assert.ok(read.action === "read" && read.entries.length === 0);
  }));
