import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { snapshotAnswer } from "../../src/integration/ooo-execution.ts";
import { httpCall } from "../../src/cli/http-client.ts";
import type { ServerState } from "../../src/cli/lifecycle.ts";
import type { TaskBoardEntry } from "../../src/core/types.ts";
import type { BoardTicket } from "./board-admission.ts";

const channel = "ooo-process-probe";
type Command = { id: string; action: string; args: Record<string, unknown> };
let command: (action: string, args: Record<string, unknown>) => Promise<unknown>;

const liveDaemon = process.argv[2] === "daemon-live";
if (process.argv[2] === "daemon" || liveDaemon) {
  const { NmgService } = await import("../../src/cli/service.ts");
  const { httpHandler } = await import("../../src/cli/http-server.ts");
  const { BoardAdmission } = await import("./board-admission.ts");
  const database = process.argv[3]!;
  const snapshot = (path: string) =>
    readFileSync(resolve(import.meta.dirname, "../..", path), "utf8").slice(0, 16_000);
  const authority = new BoardAdmission(
    database,
    liveDaemon
      ? [
          ["A", snapshot("README.md"), [], "read-only", "interface-response", "heading"],
          [
            "B",
            snapshot("docs/design/session-active-graph-runtime-design.md"),
            [],
            "read-only",
            null,
            "heading",
          ],
          ["C", "", ["A", "B"], "isolated-artifact", null, "join"],
        ]
      : undefined,
  );
  const service = new NmgService({
    databasePath: database,
    dataDirectory: dirname(database),
    environment: {},
  });
  const token = randomUUID();
  const boardHandler = httpHandler(service, token);
  const server = createServer((request, response) => {
    if (request.url !== "/admission") {
      boardHandler(request, response);
      return;
    }
    void (async () => {
      try {
        if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`)
          throw new Error("unauthenticated");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          if (size > 16_384) throw new Error("request too large");
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object") throw new Error("invalid request");
        let value: unknown;
        if (
          body.action === "claim" &&
          typeof body.task === "string" &&
          typeof body.agent === "string"
        ) {
          if (liveDaemon) authority.now = Date.now();
          value = authority.claim(body.task, body.agent);
        } else if (body.action === "submit" && typeof body.resultId === "string") {
          if (liveDaemon) authority.now = Date.now();
          value = await authority.submit(body.resultId);
        } else throw new Error("invalid action");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ value }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  let resume = () => {};
  command = async (action, args) => {
    if (liveDaemon) {
      authority.now = Date.now();
      if (!["externalReady", "next", "accepted"].includes(action))
        throw new Error("fault controls disabled for live run");
    }
    switch (action) {
      case "advance":
        if (!Number.isSafeInteger(args.milliseconds) || Number(args.milliseconds) < 0)
          throw new Error("invalid clock advance");
        authority.now += Number(args.milliseconds);
        authority.refresh();
        return authority.now;
      case "setNow":
        if (!Number.isSafeInteger(args.now) || Number(args.now) < authority.now)
          throw new Error("invalid clock");
        authority.now = Number(args.now);
        return authority.now;
      case "pauseNext":
        authority.afterVerify = async () => {
          authority.afterVerify = async () => {};
          await new Promise<void>((resolve) => {
            resume = resolve;
            process.send!({ event: "verified" });
          });
        };
        return true;
      case "pauseAfterCommit":
        authority.afterCommit = async () => {
          authority.afterCommit = async () => {};
          await new Promise<void>((resolve) => {
            resume = resolve;
            process.send!({ event: "committed" });
          });
        };
        return true;
      case "resume":
        resume();
        return true;
      case "externalReady":
        authority.externalReady(String(args.event));
        return true;
      case "observeRevision":
        authority.observeRevision(String(args.task), String(args.revision));
        return true;
      case "next":
        return authority.next();
      case "accepted":
        return authority.accepted();
      default:
        throw new Error("unknown control command");
    }
  };
  process.send!({
    event: "ready",
    value: {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      transport: "http",
      host: "127.0.0.1",
      port: address.port,
      token,
    },
  });
} else if (process.argv[2] === "worker" || process.argv[2] === "pi-worker") {
  let endpoint: ServerState;
  let agent: string;
  // Local worker scratch only. Authority/generation/completion live in the daemon DB.
  const held = new Map<string, BoardTicket>();
  const admission = async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/admission`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json()) as { value?: unknown; error?: string };
    if (!response.ok) throw new Error(result.error ?? "admission failed");
    return result.value;
  };
  const board = async (): Promise<TaskBoardEntry[]> => {
    const result = (await httpCall(endpoint, "taskBoard", {
      action: "read",
      taskId: channel,
      agentId: agent,
      includeResolved: true,
      limit: 200,
    })) as { entries: TaskBoardEntry[] };
    return result.entries;
  };
  const publish = async (task: string, override?: string): Promise<string> => {
    const ticket = held.get(task);
    if (!ticket) throw new Error("worker has no ticket");
    const artifact = override ?? snapshotAnswer(ticket);
    const result = (await httpCall(endpoint, "taskBoard", {
      action: "put",
      taskId: channel,
      agentId: agent,
      kind: "result",
      content: JSON.stringify({ ticket, artifact: override ?? artifact, passed: true }),
      ttlSeconds: 86_400,
    })) as { entry: TaskBoardEntry };
    return result.entry.id;
  };
  command = async (action, args) => {
    switch (action) {
      case "connect":
        endpoint = args.endpoint as ServerState;
        agent = String(args.agent);
        return process.pid;
      case "board":
        return board();
      case "take": {
        const task = String(args.task);
        const entry = (await board()).find(
          (item) =>
            item.kind === "handoff" &&
            item.status === "open" &&
            JSON.parse(item.content).id === task,
        );
        if (!entry) throw new Error("no ready handoff on board");
        const ticket = (await admission({ action: "claim", task, agent })) as BoardTicket;
        held.set(task, ticket);
        return ticket;
      }
      case "requestClaim":
        return admission({ action: "claim", task: args.task, agent });
      case "solve": {
        if (process.argv[2] !== "pi-worker") throw new Error("live Pi role required");
        const ticket = held.get(String(args.task));
        if (!ticket || typeof args.provider !== "string" || typeof args.model !== "string")
          throw new Error("ticket and explicit model required");
        const { executePiSnapshot } = await import("../../.pi/extensions/nmg/ooo-execution.ts");
        const execution = await executePiSnapshot(ticket, args.provider, args.model);
        const resultId = await publish(ticket.taskId, execution.artifact);
        const verdict = await admission({ action: "submit", resultId });
        return { ...execution, verdict, workerPid: process.pid, taskId: ticket.taskId };
      }
      case "publish":
        return publish(
          String(args.task),
          typeof args.artifact === "string" ? args.artifact : undefined,
        );
      case "submit":
        return admission({ action: "submit", resultId: args.resultId });
      case "deliver":
        return admission({ action: "submit", resultId: await publish(String(args.task)) });
      default:
        throw new Error("unknown worker command");
    }
  };
  process.send!({ event: "ready", value: process.pid });
} else throw new Error("fixture requires daemon or worker role");

process.on("message", (message: Command) => {
  void command(message.action, message.args).then(
    (value) => process.send!({ id: message.id, value }),
    (error) => process.send!({ id: message.id, error: String(error) }),
  );
});
process.on("disconnect", () => process.exit(0));
