import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { httpHandler } from "../../src/cli/http-server.ts";
import { NmgService } from "../../src/cli/service.ts";
import { assertSnapshotJsonSafe } from "../helpers/json-value-safety.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

interface RegisteredDshTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: unknown): Promise<unknown>;
}

function saveEnv(next: Record<string, string>): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(next)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return previous;
}

function restoreEnv(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function buildMockCordisContext(
  directory: string,
  tools: Map<string, RegisteredDshTool>,
  onSubprocess: () => void,
) {
  return {
    tools: {
      register(tool: RegisteredDshTool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    subprocess: {
      resolveExecutable: async () => process.execPath,
      spawn() {
        onSubprocess();
        throw new Error("CLI fallback must not run when daemon JSON-RPC is healthy");
      },
    },
    sandboxPolicy: { workspaceRoot: directory },
    systemPrompt: {
      context: () => () => {},
    },
    on: () => () => {},
    get: () => undefined,
    interval: () => () => {},
    timeout: () => () => {},
    reflect: { get: () => undefined },
  };
}

async function withDshHttpFixture(
  run: (fixture: {
    tools: Map<string, RegisteredDshTool>;
    requests: Array<{ method: string; params: Record<string, unknown> }>;
    subprocessCount: () => number;
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "nmg-dsh-int-"));
  const envBackup = saveEnv({
    NMG_DATA_DIR: directory,
    NMG_PROJECT_DIR: directory,
    USERPROFILE: directory,
    HOME: directory,
    NMG_ENABLE_COORDINATION: "0",
    NMG_AGENT_ID: "dsh-integration-host",
  });
  const service = new NmgService({ dataDirectory: directory });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body));
    });
    void httpHandler(service, "integration-token")(req, res);
  });
  let dispose: (() => Promise<void>) | undefined;
  let subprocessCalls = 0;

  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      join(directory, "nmg.sqlite.server.json"),
      JSON.stringify({
        pid: process.pid,
        transport: "http",
        host: "127.0.0.1",
        port,
        token: "integration-token",
      }),
    );

    const pluginUrl = pathToFileURL(
      resolve(import.meta.dirname, "../../dsh/dsh-nmg/src/plugin/index.ts"),
    ).href;
    const plugin = (await import(pluginUrl)) as {
      apply(ctx: unknown): (() => Promise<void>) & { ready: Promise<void> };
    };
    const tools = new Map<string, RegisteredDshTool>();
    const contribution = plugin.apply(
      buildMockCordisContext(directory, tools, () => {
        subprocessCalls++;
      }),
    );
    dispose = contribution;
    await contribution.ready;

    await run({ tools, requests, subprocessCount: () => subprocessCalls });
  } finally {
    await dispose?.();
    await new Promise<void>((done) => server.close(() => done()));
    await service.close();
    rmSync(directory, { recursive: true, force: true });
    restoreEnv(envBackup);
  }
}

test("DSH plugin registers 6 JSON-snapshot-safe tools and executes them over daemon JSON-RPC", async () => {
  await withDshHttpFixture(async ({ tools, requests, subprocessCount }) => {
    assert.deepEqual([...tools.keys()].sort(), [
      "nmg_daemon",
      "nmg_get",
      "nmg_lab",
      "nmg_remember",
      "nmg_search",
      "nmg_state",
    ]);

    for (const tool of tools.values()) {
      assertSnapshotJsonSafe(
        { name: tool.name, description: tool.description, parameters: tool.parameters },
        `dsh-plugin:${tool.name}`,
      );
    }

    const sessionCtx = { agent: { id: "dsh-int-session" }, signal: new AbortController().signal };

    const health = String(await tools.get("nmg_daemon")!.execute({ action: "status" }, sessionCtx));
    assert.match(health, /running/u);

    const remembered = String(
      await tools.get("nmg_remember")!.execute(
        {
          action: "save",
          statement: "DshIntegrationToken verifies full tool roundtrip over HTTP RPC.",
          nodeName: "DSH Integration",
          memoryType: "fact",
        },
        sessionCtx,
      ),
    );
    const idMatch = remembered.match(/Saved ([0-9a-f]{16,})\b/u);
    assert.ok(idMatch, `Expected saved memory id in: ${remembered}`);
    const savedId = idMatch[1]!;

    const searched = String(
      await tools.get("nmg_search")!.execute({ query: "DshIntegrationToken" }, sessionCtx),
    );
    assert.match(searched, new RegExp(`ref:${savedId.slice(0, 4)}\\|`, "u"));
    assert.match(searched, /DshIntegrationToken verifies full tool roundtrip/u);

    const fetched = String(
      await tools.get("nmg_get")!.execute({ memoryIds: [savedId] }, sessionCtx),
    );
    assert.match(fetched, /DshIntegrationToken verifies full tool roundtrip/u);

    await tools
      .get("nmg_state")!
      .execute(
        { space: "ag", action: "write", operation: "enable", reason: "dsh integration state" },
        sessionCtx,
      );
    await tools
      .get("nmg_state")!
      .execute(
        { space: "ag", action: "write", operation: "replace", text: "DSH active rule." },
        sessionCtx,
      );
    const readState = String(
      await tools.get("nmg_state")!.execute({ space: "ag", action: "read" }, sessionCtx),
    );
    assert.match(readState, /DSH active rule/u);

    const labList = String(await tools.get("nmg_lab")!.execute({ action: "list" }, sessionCtx));
    assert.match(labList, /recall_gate/u);

    assert.equal(subprocessCount(), 0);
    assert.ok(requests.some((req) => req.method === "remember"));
    assert.ok(requests.some((req) => req.method === "search"));
    assert.ok(requests.some((req) => req.method === "get"));
  });
});

test("Legacy DSH composition plugin (dsh/nmg-plugin.mjs) schemas are also JSON-snapshot-safe", async () => {
  const pluginUrl = pathToFileURL(resolve(import.meta.dirname, "../../dsh/nmg-plugin.mjs")).href;
  const legacy = (await import(pluginUrl)) as {
    default: { apply(ctx: unknown): void };
  };
  const registered: RegisteredDshTool[] = [];
  legacy.default.apply({
    get(name: string) {
      if (name === "tools") {
        return {
          register(tool: RegisteredDshTool) {
            registered.push(tool);
            return () => {};
          },
        };
      }
      if (name === "subprocess") {
        return {
          resolveExecutable: async () => process.execPath,
          spawn() {
            throw new Error("Unused in schema test");
          },
        };
      }
      if (name === "sandboxPolicy") return { workspaceRoot: process.cwd() };
      return undefined;
    },
    on: () => () => {},
    intercept: () => () => {},
  });

  assert.equal(registered.length, 5);
  for (const tool of registered) {
    assertSnapshotJsonSafe(
      { name: tool.name, description: tool.description, parameters: tool.parameters },
      `dsh-legacy:${tool.name}`,
    );
  }
});
