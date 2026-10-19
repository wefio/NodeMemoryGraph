import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../../opencode-plugin/index.ts";
import { NmgService } from "../../src/cli/service.ts";
import { httpHandler } from "../../src/cli/http-server.ts";
import { dropCompatibleLease } from "../../src/integration/lease-transport.ts";
import { deliverBoardWake } from "../../src/integration/board-wake.ts";
import { requireBoardEventCapability } from "../../src/integration/state.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";
stripProviderEnv();

test("real OpenCode registration forwards event payloads and public status to private HTTP owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-event-opencode-"));
  const environment = {
    NMG_DATA_DIR: directory,
    NMG_AGENT_ID: "opencode-event-agent",
    NMG_ENABLE_COORDINATION: "1",
  };
  const old = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const service = new NmgService({ dataDirectory: directory });
  const token = "private-event-fixture-token";
  const server = createServer(httpHandler(service, token));
  type Tool = {
    name: string;
    input: Record<string, unknown>;
    execute(args: Record<string, unknown>, context: { sessionID: string }): Promise<unknown>;
  };
  const tools = new Map<string, Tool>();
  let dispose: (() => Promise<void>) | undefined;
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    writeFileSync(
      join(directory, "nmg.sqlite.server.json"),
      JSON.stringify({
        transport: "http",
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        token,
        pid: process.pid,
      }),
    );
    writeFileSync(join(directory, "board-wake.json"), JSON.stringify({ enabled: false }));
    dispose = await plugin.setup({
      session: { async hook() {} },
      event: { async *subscribe() {} },
      tool: {
        async hook() {},
        async transform(edit) {
          edit({
            add(tool) {
              tools.set(tool.name, tool);
            },
          });
        },
      },
    });
    const state = tools.get("state")!;
    assert.match(JSON.stringify(state.input), /eventId/);
    assert.match(JSON.stringify(state.input), /eventUpdate/);
    assert.match(JSON.stringify(state.input), /notification/);
    const context = { sessionID: "event-test-session" };
    const created = await state.execute(
      {
        action: "write",
        space: "board",
        operation: "eventCreate",
        event: { title: "OpenCode collaboration", participants: ["receiver"] },
      },
      context,
    );
    assert.match(JSON.stringify(created), /OpenCode collaboration/);
    const list = await service.invoke("state", {
      action: "read",
      space: "board",
      operation: "eventRead",
      agentId: "reader",
    });
    assert.ok("events" in list.result && list.result.events?.length);
    const eventId = "events" in list.result && list.result.events![0]!.id;
    const ended = await state.execute(
      {
        action: "write",
        space: "board",
        operation: "eventUpdate",
        eventId,
        event: {
          expectedRevision: 1,
          kind: "close",
          text: "Discussion finished",
          outcome: "failed",
        },
      },
      context,
    );
    assert.match(JSON.stringify(ended), /ended/);
    const note = await state.execute(
      { action: "write", space: "board", operation: "agentStatus", text: "Waiting for review" },
      context,
    );
    assert.match(JSON.stringify(note), /Waiting for review/);
    const inbox = await service.invoke("taskBoard", {
      action: "readInbox",
      agentId: "receiver",
      agentName: "receiver",
    });
    assert.equal(
      inbox.action === "readInbox" &&
        inbox.entries.filter((entry) => entry.eventRevision === 2).length,
      1,
    );
    await state.execute(
      {
        action: "write",
        space: "board",
        operation: "put",
        taskId: "native-discussion",
        content: "Compare options here",
        agentId: "forged-author",
        notification: {
          key: "native-invite",
          scopes: ["direct"],
          recipients: ["receiver"],
          invite: true,
        },
      },
      context,
    );
    const invited = await service.invoke("taskBoard", {
      action: "readInbox",
      agentId: "receiver",
      agentName: "receiver",
    });
    assert.ok(
      invited.action === "readInbox" &&
        invited.entries.some(
          (entry) => entry.invitation && entry.agentId === "opencode-event-agent",
        ),
    );
    const subscribed = await service.invoke("taskBoard", {
      action: "listSubscriptions",
      agentId: "receiver",
      sessionId: "replacement-session",
    });
    assert.ok(
      subscribed.action === "listSubscriptions" &&
        subscribed.subscriptions.some((s) => s.taskId === "native-discussion"),
    );
  } finally {
    await dispose?.();
    dropCompatibleLease(directory);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    service.close();
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("event fields refuse an older owner without changing ordinary board calls", async () => {
  let checks = 0;
  const hello = async () => {
    checks++;
    return { capabilities: ["state-spaces"] };
  };
  await requireBoardEventCapability({ space: "board", operation: "read" }, hello);
  assert.equal(checks, 0);
  await assert.rejects(
    requireBoardEventCapability({ space: "board", operation: "put", eventId: "event" }, hello),
    /board-events/,
  );
  await assert.rejects(
    requireBoardEventCapability({ space: "board", operation: "eventRead" }, hello),
    /board-events/,
  );
  await assert.rejects(
    requireBoardEventCapability(
      { space: "board", operation: "put", notification: { key: "n", scopes: ["direct"] } },
      hello,
    ),
    /board-events/,
  );
  assert.equal(checks, 3);
});

test("shared wake awaits host enqueue and never turns event notices into broadcasts or claims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-event-wake-"));
  const entry = {
    id: "notice",
    taskId: "__nmg_event_updates__",
    sequence: 0,
    agentId: "a",
    to: "b",
    status: "open",
    kind: "note",
    content: "Event ended",
    eventId: "event",
    eventRevision: 2,
    eventNotice: true,
  };
  const state = { budgetDate: "2026-10-18", budgetUsed: 0, lastWakeAt: 0 };
  const calls: string[] = [],
    messages: string[] = [];
  const input = {
    invoke: async (method: string) => {
      calls.push(method);
      return {};
    },
    entry,
    agentId: "b",
    sessionId: "b-session",
    config: { enabled: true, budget: 8, cooldownMs: 0, intervalMs: 60000, worldBroadcast: true },
    state,
    dataDir: directory,
    now: Date.now(),
  };
  try {
    for (const candidate of [
      entry,
      {
        ...entry,
        eventNotice: false,
        notificationSourceId: "discussion-source",
        notificationChannelId: "discussion",
        notificationScopes: ["direct" as const],
        invitation: true,
      },
    ]) {
      calls.length = 0;
      messages.length = 0;
      state.budgetUsed = 0;
      input.entry = candidate;
      await assert.rejects(
        deliverBoardWake({
          ...input,
          sendWake: async () => {
            throw Error("enqueue failed");
          },
        }),
        /enqueue failed/,
      );
      assert.deepEqual(calls, []);
      assert.equal(state.budgetUsed, 0);
      await deliverBoardWake({
        ...input,
        sendWake: async (message) => {
          messages.push(message);
        },
      });
      assert.equal(calls.length, 1, "only the delivery receipt, no world put");
      assert.match(messages[0]!, /not a task handoff/);
      assert.equal(state.budgetUsed, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
