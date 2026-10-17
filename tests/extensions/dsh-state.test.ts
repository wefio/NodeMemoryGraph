import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { httpHandler } from "../../src/cli/http-server.ts";
import { NmgService } from "../../src/cli/service.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

type HostTool = {
  name: string;
  parameters: { properties: Record<string, { enum?: string[] }> };
  execute(args: Record<string, unknown>, context: unknown): Promise<unknown>;
};

async function withHost(
  coordination: boolean,
  run: (host: {
    tools: Map<string, HostTool>;
    service: NmgService;
    requests: Array<{ method: string; params: Record<string, unknown> }>;
    subprocessCalls: () => number;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-dsh-state-"));
  const environment = {
    NMG_DATA_DIR: directory,
    NMG_PROJECT_DIR: directory,
    USERPROFILE: directory,
    HOME: directory,
    NMG_ENABLE_COORDINATION: coordination ? "1" : "0",
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
  let dispose: (() => void) | undefined;
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
      apply(context: unknown): () => void;
    };
    const tools = new Map<string, HostTool>();
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
        context() {
          return () => {};
        },
      },
      on() {
        return () => {};
      },
      interval() {
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
      tools,
      service,
      requests,
      subprocessCalls: () => subprocessCalls,
    });
  } finally {
    dispose?.();
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

test("DSH uses the board owner and does not retry or CLI-fallback a refused AG write", async () => {
  await withHost(true, async ({ tools, requests, subprocessCalls }) => {
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
