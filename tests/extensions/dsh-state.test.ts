import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { httpHandler } from "../../src/cli/http-server.ts";
import { NmgService } from "../../src/cli/service.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("DSH remember exposes and forwards the historical event clock to its HTTP owner", async () => {
  await withHost(false, async ({ tools, service, requests }) => {
    const remember = tools.get("nmg_remember")!;
    assert.ok(remember.parameters.properties.referenceTime);
    assert.ok(remember.parameters.properties.timeZone);
    await remember.execute(
      {
        statement: "DshHistoricalClockMarker",
        nodeName: "历史",
        eventTime: "昨天",
        referenceTime: "2025-05-10T00:30:00+08:00",
        timeZone: "Asia/Shanghai",
      },
      { agent: { id: "historical-session" } },
    );
    const saved = requests.find((request) => request.method === "remember")!;
    assert.equal(saved.params.referenceTime, "2025-05-10T00:30:00+08:00");
    assert.equal(saved.params.timeZone, "Asia/Shanghai");
    const result = await service.invoke("search", { query: "DshHistoricalClockMarker" });
    assert.equal(result.results[0]?.memory.eventTime, "2025-05-09T00:00:00.000Z");
  });
});

test("DSH exposes actual sessions and withdraws them when their native endpoint disappears", async () => {
  await withHost(true, async ({ service, agents, wake, directory, disposeAgent, stop }) => {
    const legacyId = `dsh:${basename(directory)}`;
    await service.invoke("taskBoard", {
      action: "registerAgent",
      id: legacyId,
      agentName: "Legacy adapter",
    });
    const roster = async () => {
      const result = await service.invoke("taskBoard", {
        action: "discover",
        agentId: "observer",
        taskId: "default",
      });
      if (result.action !== "discover") throw Error("Missing roster");
      return result.agents.map((agent) => agent.id);
    };
    await wake();
    assert.deepEqual(await roster(), []);
    agents.set("actual-session", { id: "actual-session", status: "idle", send: async () => {} });
    await wake();
    assert.deepEqual(await roster(), ["actual-session"]);
    await disposeAgent(agents.get("actual-session")!);
    assert.deepEqual(await roster(), []);
    agents.clear();
    await wake();
    assert.deepEqual(await roster(), []);
    agents.set("replacement", { id: "replacement", status: "idle", send: async () => {} });
    await wake();
    assert.deepEqual(await roster(), ["replacement"]);
    agents.clear();
    await wake();
    assert.deepEqual(await roster(), []);
    agents.set("last-session", { id: "last-session", status: "idle", send: async () => {} });
    await wake();
    await stop();
    assert.deepEqual(await roster(), []);
  });
});

test("DSH directs a notice to one native recipient and keeps channel subscriptions independent", async () => {
  await withHost(true, async ({ service, agents, wake, tools, requests }) => {
    const received = new Map<string, string[]>();
    for (const id of ["session-a", "session-b"]) {
      received.set(id, []);
      agents.set(id, {
        id,
        status: "idle",
        send: async (message) => {
          received.get(id)!.push(message.content.map((part) => part.text).join(""));
        },
      });
    }
    const state = tools.get("nmg_state")!;
    const execution = { agent: agents.get("session-a"), signal: new AbortController().signal };
    await state.execute(
      {
        space: "board",
        action: "write",
        operation: "subscribe",
        taskId: "discussion",
        agentId: "forged",
      },
      execution,
    );
    await state.execute(
      {
        space: "board",
        action: "write",
        operation: "rename",
        agentName: "DSH reviewer",
      },
      execution,
    );
    await service.invoke("taskBoard", {
      action: "put",
      taskId: "discussion",
      agentId: "peer",
      kind: "note",
      content: "Channel reply",
    });
    await service.invoke("taskBoard", {
      action: "put",
      taskId: "private",
      agentId: "peer",
      kind: "question",
      to: "session-b",
      content: "Only session B",
    });
    await service.invoke("taskBoard", {
      action: "put",
      taskId: "private",
      agentId: "peer",
      kind: "question",
      to: "DSH reviewer",
      content: "By current display name",
    });
    const inbox = await state.execute(
      { space: "board", action: "read", operation: "readInbox" },
      execution,
    );
    assert.match(String(inbox), /By current display name/);
    await wake();
    assert.equal(received.get("session-a")!.length, 1);
    assert.match(received.get("session-a")![0]!, /Channel reply/);
    assert.match(received.get("session-a")![0]!, /By current display name/);
    assert.doesNotMatch(received.get("session-a")![0]!, /Only session B/);
    assert.equal(received.get("session-b")!.length, 1);
    assert.match(received.get("session-b")![0]!, /Only session B/);
    assert.doesNotMatch(received.get("session-b")![0]!, /Channel reply/);
    assert.doesNotMatch(received.get("session-b")![0]!, /By current display name/);
    const subscription = requests.find((request) => request.params.operation === "subscribe")!;
    assert.equal(subscription.params.agentId, "session-a");
    assert.equal(subscription.params.sessionId, "session-a");
    assert.equal(
      requests.some((request) => request.method === "taskBoard" && request.params.action === "put"),
      false,
    );
  });
});

test("DSH requires a native actor and resumes a continuable child under its own identity", async () => {
  await withHost(true, async ({ service, agents, children, resumed, wake, tools }) => {
    const state = tools.get("nmg_state")!;
    await assert.rejects(
      state.execute(
        { space: "board", action: "read" },
        {
          signal: new AbortController().signal,
        },
      ),
      /native DSH Agent session/,
    );
    const parentMessages: string[] = [];
    agents.set("parent", {
      id: "parent",
      status: "idle",
      send: async (message) => {
        parentMessages.push(message.content.map((part) => part.text).join(""));
      },
    });
    children.set("parent", [{ id: "child", kind: "child", mode: "continuable" }]);
    await service.invoke("taskBoard", {
      action: "put",
      taskId: "child-work",
      agentId: "peer",
      kind: "question",
      to: "child",
      content: "Resume child only",
    });
    await wake();
    assert.deepEqual(parentMessages, []);
    assert.equal(resumed.get("child")?.length, 1);
    const roster = await service.invoke("taskBoard", {
      action: "discover",
      agentId: "observer",
      taskId: "default",
    });
    assert.ok(roster.action === "discover");
    assert.deepEqual(new Set(roster.agents.map((agent) => agent.id)), new Set(["parent", "child"]));
  });
});

test("DSH retries a failed presence withdrawal on a later empty-host poll", async (t) => {
  for (const failureMode of ["error", "missing-response"])
    await withHost(true, async ({ service, agents, wake }) => {
      agents.set("retiring-session", {
        id: "retiring-session",
        status: "idle",
        send: async () => {},
      });
      await wake();
      const invoke = service.invoke.bind(service);
      let failures = 1;
      t.mock.method(service, "invoke", (async (method, params) => {
        const request = params as { action?: string; id?: string };
        if (
          method === "taskBoard" &&
          request.action === "unregisterAgent" &&
          request.id === "retiring-session" &&
          failures > 0
        ) {
          failures--;
          if (failureMode === "error") throw new Error("temporary withdrawal failure");
          return undefined;
        }
        return invoke(method, params);
      }) as typeof service.invoke);
      agents.clear();
      await wake();
      assert.equal(failures, 0);
      await wake();
      const result = await service.invoke("taskBoard", {
        action: "discover",
        taskId: "default",
        agentId: "observer",
      });
      assert.ok(result.action === "discover");
      assert.deepEqual(result.agents, []);
    });
});

test("DSH batches twelve peers for eight recipients and drains busy recipients on idle", async () => {
  await withHost(true, async ({ service, agents, wake, requests }) => {
    const received = new Map<string, string[]>();
    for (let i = 0; i < 8; i++) {
      const id = `recipient-${i}`;
      received.set(id, []);
      agents.set(id, {
        id,
        status: i < 2 ? "running" : "idle",
        send: async (message) => {
          received.get(id)!.push(message.content.map((part) => part.text).join(""));
        },
      });
    }
    for (const id of agents.keys())
      await service.invoke("taskBoard", {
        action: "subscribe",
        taskId: "discussion",
        agentId: id,
        sessionId: id,
      });
    await service.invoke("state", {
      space: "board",
      action: "write",
      operation: "agentActivity",
      agentId: "recipient-1",
      sessionId: "recipient-1",
      activity: { state: "busy" },
    });
    for (let i = 0; i < 12; i++)
      await service.invoke("taskBoard", {
        action: "put",
        taskId: "discussion",
        agentId: `peer-${i}`,
        kind: "note",
        content: `Distinct reply from peer-${i}.`,
      });
    await wake();
    for (let i = 0; i < 8; i++) {
      const messages = received.get(`recipient-${i}`)!;
      assert.equal(messages.length, i < 2 ? 0 : 1);
      if (i >= 2)
        for (let peer = 0; peer < 12; peer++)
          assert.ok(messages[0]!.includes(`Distinct reply from peer-${peer}.`));
    }
    agents.get("recipient-0")!.status = "idle";
    agents.get("recipient-1")!.status = "idle";
    await wake();
    assert.equal(
      received.get("recipient-1")!.length,
      0,
      "explicit board busy survives a native idle observation",
    );
    await service.invoke("state", {
      space: "board",
      action: "write",
      operation: "agentActivity",
      agentId: "recipient-1",
      sessionId: "recipient-1",
      activity: { state: "idle" },
    });
    await wake();
    for (const messages of received.values()) assert.equal(messages.length, 1);
    const receipts = requests.filter(
      (request) => request.method === "taskBoard" && request.params.action === "recordDelivery",
    );
    assert.equal(receipts.length, 8);
    assert.ok(
      receipts.every(
        (request) =>
          Array.isArray(request.params.entryIds) && request.params.entryIds.length === 12,
      ),
    );
  });
});

type HostTool = {
  name: string;
  parameters: { properties: Record<string, { enum?: string[] }> };
  execute(args: Record<string, unknown>, context: unknown): Promise<unknown>;
};
type WakeHostAgent = {
  id: string;
  status: "idle" | "running";
  send(message: { content: Array<{ text: string }> }): Promise<void>;
};
type WakeChild = { id: string; kind: "child"; mode: "continuable" };

async function withHost(
  coordination: boolean,
  run: (host: {
    tools: Map<string, HostTool>;
    service: NmgService;
    requests: Array<{ method: string; params: Record<string, unknown> }>;
    subprocessCalls: () => number;
    inbox: (text: string) => void;
    recall: () => string;
    wake: () => Promise<void>;
    agents: Map<string, WakeHostAgent>;
    children: Map<string, WakeChild[]>;
    resumed: Map<string, string[]>;
    disposeAgent: (agent: WakeHostAgent) => Promise<void>;
    stop: () => Promise<void>;
    directory: string;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-dsh-state-"));
  const environment = {
    NMG_DATA_DIR: directory,
    NMG_PROJECT_DIR: directory,
    USERPROFILE: directory,
    HOME: directory,
    NMG_ENABLE_COORDINATION: coordination ? "1" : "0",
    NMG_AGENT_ID: "dsh-host-process",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const service = new NmgService({ dataDirectory: directory });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
    });
    void httpHandler(service, "fixture-token")(request, response);
  });
  let dispose: (() => Promise<void>) | undefined;
  let subprocessCalls = 0;
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    writeFileSync(
      join(directory, "nmg.sqlite.server.json"),
      JSON.stringify({
        pid: process.pid,
        transport: "http",
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        token: "fixture-token",
      }),
    );
    // The real host contribution is loaded; only the consumed Cordis services are simulated.
    const path = pathToFileURL(
      resolve(import.meta.dirname, "../../dsh/dsh-nmg/src/plugin/index.ts"),
    ).href;
    const plugin = (await import(path)) as {
      apply(context: unknown): () => Promise<void>;
    };
    const tools = new Map<string, HostTool>();
    const events = new Map<string, (payload: unknown) => void>();
    const contributions = new Map<string, (context: unknown) => string>();
    const agents = new Map<string, WakeHostAgent>();
    const children = new Map<string, WakeChild[]>();
    const resumed = new Map<string, string[]>();
    let wake = async () => {};
    dispose = plugin.apply({
      tools: {
        register(tool: HostTool) {
          tools.set(tool.name, tool);
          return () => tools.delete(tool.name);
        },
      },
      subprocess: {
        async resolveExecutable() {
          return process.execPath;
        },
        spawn() {
          subprocessCalls++;
          throw new Error("CLI fallback is forbidden in this fixture");
        },
      },
      sandboxPolicy: { workspaceRoot: directory },
      systemPrompt: {
        context(input: { name: string; text: (context: unknown) => string }) {
          contributions.set(input.name, input.text);
          return () => {};
        },
      },
      on(name: string, handler: (payload: unknown) => void) {
        events.set(name, handler);
        return () => {};
      },
      get(name: string) {
        if (name === "agents") return { list: () => [...agents.values()] };
        if (name === "subagents")
          return {
            listChildren: async (parentId: string) => children.get(parentId) ?? [],
            followup: async (
              _parent: WakeHostAgent,
              childId: string,
              parts: Array<{ text: string }>,
            ) => {
              const messages = resumed.get(childId) ?? [];
              messages.push(parts.map((part) => part.text).join(""));
              resumed.set(childId, messages);
            },
          };
        return undefined;
      },
      interval(callback: () => Promise<void>) {
        wake = callback;
        return () => {};
      },
      timeout() {
        return () => {};
      },
      reflect: {
        get() {
          return undefined;
        },
      },
    });
    await run({
      wake: () => wake(),
      agents,
      children,
      resumed,
      disposeAgent: async (agent) => {
        await events.get("agent/disposed")!({ agent });
      },
      stop: async () => {
        await dispose?.();
        dispose = undefined;
      },
      directory,
      tools,
      service,
      requests,
      subprocessCalls: () => subprocessCalls,
      inbox: (text) =>
        events.get("agent/inbox/inserted")!({
          agent: { id: "dsh-recall" },
          message: { content: [{ type: "text", text }] },
        }),
      recall: () => contributions.get("nmg:recall")!({ agent: { id: "dsh-recall" } }),
    });
  } finally {
    await dispose?.();
    await new Promise<void>((done) => server.close(() => done()));
    service.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const context = {
  agent: { id: "dsh-owner" },
  signal: new AbortController().signal,
};
const ag = { space: "ag" };

test("DSH automatic context is budgeted and unconfirmed; a new empty turn excludes its old snapshot", async () => {
  await withHost(false, async ({ service, requests, inbox, recall }) => {
    await service.invoke("remember", {
      statement: "Atlas uses SQLite offline",
      nodeName: "Atlas storage",
    });
    inbox("What did we decide about Atlas SQLite storage?");
    const deadline = Date.now() + 3_000;
    while (!recall() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const text = recall();
    assert.match(text, /Atlas uses SQLite/);
    assert.ok(text.length <= 16_000);
    assert.match(text, /candidate preview; not exact evidence/);
    assert.equal(
      requests.some((r) => r.params.action === "disclose"),
      false,
    );
    assert.equal(recall(), text, "repeated context assembly preserves the prepared fragment");
    inbox("");
    assert.equal(recall(), "");
  });
});

test("DSH registers one state tool, keeps AG usable without coordination, and rejects Lab daily-state writes", async () => {
  await withHost(false, async ({ tools, service, subprocessCalls }) => {
    assert.ok(tools.has("nmg_state"));
    assert.ok(tools.has("nmg_daemon"));
    assert.equal(tools.has("nmg_board"), false);
    const lab = tools.get("nmg_lab")!;
    assert.equal(lab.parameters.properties.capability.enum?.includes("working_state"), false);
    await assert.rejects(
      lab.execute({ action: "enable", capability: "working_state", reason: "test" }, context),
      /nmg_state/u,
    );
    const state = tools.get("nmg_state")!;
    await state.execute(
      {
        ...ag,
        action: "write",
        operation: "enable",
        reason: "maintain current state",
      },
      context,
    );
    assert.equal(
      await state.execute(
        {
          ...ag,
          action: "write",
          operation: "replace",
          text: "Current DSH constraint.",
        },
        context,
      ),
      "updated",
    );
    assert.equal(
      await state.execute({ ...ag, action: "read" }, context),
      "[temporary] Current DSH constraint.",
    );
    await state.execute({ ...ag, action: "write", operation: "disable" }, context);
    assert.equal(
      await state.execute({ ...ag, action: "read" }, context),
      "[temporary] Current DSH constraint.",
    );
    await assert.rejects(
      state.execute(
        {
          action: "write",
          space: "board",
          operation: "put",
          content: "Must not publish.",
        },
        context,
      ),
      /disabled/u,
    );
    const board = await service.invoke("taskBoard", {
      action: "read",
      taskId: "default",
      agentId: "dsh-owner",
    });
    assert.equal(board.action === "read" && board.entries.length, 0);
    assert.equal(subprocessCalls(), 0);
  });
});

test("DSH forwards event objects and pins mutation identity to its registered actor", async () => {
  await withHost(true, async ({ tools, service, requests, subprocessCalls }) => {
    const tool = tools.get("nmg_state")!;
    const context = { agent: { id: "host-session" }, signal: new AbortController().signal };
    const created = await tool.execute(
      {
        action: "write",
        space: "board",
        operation: "eventCreate",
        agentId: "spoofed",
        event: { title: "DSH event" },
      },
      context,
    );
    assert.match(String(created), /DSH event/u);
    const request = requests.find(
      (r) => r.method === "state" && r.params.operation === "eventCreate",
    )!;
    assert.equal(request.params.agentId, "host-session");
    assert.equal(request.params.sessionId, "host-session");
    const listed = await service.invoke("state", {
      action: "read",
      space: "board",
      operation: "eventRead",
      agentId: "reader",
    });
    assert.ok(
      "events" in listed.result &&
        listed.result.events?.some((event) => event.title === "DSH event"),
    );
    assert.equal(subprocessCalls(), 0);
  });
});

test("DSH uses the board owner and does not retry or CLI-fallback a refused AG write", async () => {
  await withHost(true, async ({ tools, service, requests, subprocessCalls }) => {
    const state = tools.get("nmg_state")!;
    await state.execute(
      {
        action: "write",
        space: "board",
        operation: "put",
        taskId: "dsh-task",
        content: "Shared DSH work.",
      },
      context,
    );
    assert.match(
      String(await state.execute({ action: "read", space: "board", taskId: "dsh-task" }, context)),
      /Shared DSH work/u,
    );
    await state.execute(
      {
        ...ag,
        action: "write",
        operation: "enable",
        reason: "maintain current state",
      },
      context,
    );
    await state.execute(
      {
        ...ag,
        action: "write",
        operation: "replace",
        text: "Preserve this state.",
      },
      context,
    );
    await state.execute(
      {
        action: "write",
        space: "board",
        operation: "put",
        taskId: "dsh-invitation",
        content: "Discuss options",
        agentId: "forged-author",
        notification: {
          key: "dsh-invite",
          scopes: ["direct"],
          recipients: ["dsh-invitee"],
          invite: true,
        },
      },
      context,
    );
    const invited = await service.invoke("taskBoard", {
      action: "readInbox",
      agentId: "dsh-invitee",
      agentName: "dsh-invitee",
    });
    assert.ok(
      invited.action === "readInbox" &&
        invited.entries.some((entry) => entry.invitation && entry.agentId !== "forged-author"),
    );
    const before = requests.length;
    const denied = await state.execute(
      { ...ag, action: "write", operation: "replace", text: " " },
      context,
    );
    assert.match(String(denied), /text is required/u);
    assert.equal(
      requests.slice(before).filter((request) => request.params.operation === "replace").length,
      1,
    );
    assert.equal(
      await state.execute({ ...ag, action: "read" }, context),
      "[temporary] Preserve this state.",
    );
    assert.equal(subprocessCalls(), 0);
  });
});
