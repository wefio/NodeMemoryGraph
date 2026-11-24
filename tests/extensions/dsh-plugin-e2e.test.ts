import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertSnapshotJsonSafe } from "../helpers/json-value-safety.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

interface RegisteredDshTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: unknown): Promise<unknown>;
}

interface SpawnSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

function createRealSubprocessService() {
  return {
    resolveExecutable: async () => process.execPath,
    spawn(spec: SpawnSpec) {
      const [file, ...args] = spec.argv;
      const collected: {
        stdout?: { readFrom: (offset: number) => { text: string } };
        stderr?: { readFrom: (offset: number) => { text: string } };
      } = {};
      let stdoutText = "";
      let stderrText = "";
      const done = new Promise<{ exitCode: number }>((resolveExit) => {
        execFile(
          file!,
          args,
          {
            cwd: spec.cwd,
            env: spec.env ?? process.env,
            signal: spec.signal,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            stdoutText = stdout ?? "";
            stderrText = stderr ?? "";
            const code =
              error && typeof (error as { code?: unknown }).code === "number"
                ? ((error as { code: number }).code ?? 1)
                : error
                  ? 1
                  : 0;
            resolveExit({ exitCode: code });
          },
        );
      });
      return {
        done: done.then((exit) => {
          collected.stdout = { readFrom: () => ({ text: stdoutText }) };
          collected.stderr = { readFrom: () => ({ text: stderrText }) };
          return exit;
        }),
        collected,
      };
    },
  };
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

async function loadPluginTools(modulePath: string, dataDir: string) {
  const tools = new Map<string, RegisteredDshTool>();
  const pluginUrl = pathToFileURL(modulePath).href;
  const plugin = (await import(pluginUrl)) as {
    apply(ctx: unknown): (() => Promise<void>) & { ready: Promise<void> };
  };
  const dispose = plugin.apply({
    tools: {
      register(tool: RegisteredDshTool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    subprocess: createRealSubprocessService(),
    sandboxPolicy: { workspaceRoot: process.cwd() },
    systemPrompt: { context: () => () => {} },
    on: () => () => {},
    get: () => undefined,
    interval: () => () => {},
    timeout: () => () => {},
    reflect: { get: () => undefined },
  });
  await dispose.ready;
  assert.ok(existsSync(resolve(process.cwd(), "bin/nmg.mjs")));
  assert.ok(existsSync(dataDir));
  return { tools, dispose };
}

test("DSH plugin E2E: CLI-fallback remember -> search -> get works end-to-end against bin/nmg.mjs", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "nmg-dsh-e2e-"));
  const envBackup = saveEnv({
    NMG_DATA_DIR: dataDir,
    NMG_PROJECT_DIR: process.cwd(),
    USERPROFILE: dataDir,
    HOME: dataDir,
    NMG_ENABLE_COORDINATION: "0",
    NMG_AGENT_ID: "dsh-e2e-host",
  });
  let disposeSource: (() => Promise<void>) | undefined;
  let disposeBuilt: (() => Promise<void>) | undefined;

  try {
    const sourcePlugin = resolve(process.cwd(), "dsh/dsh-nmg/src/plugin/index.ts");
    const loaded = await loadPluginTools(sourcePlugin, dataDir);
    disposeSource = loaded.dispose;

    for (const tool of loaded.tools.values()) {
      assertSnapshotJsonSafe(
        { name: tool.name, description: tool.description, parameters: tool.parameters },
        `dsh-e2e:${tool.name}`,
      );
    }

    const sessionCtx = { agent: { id: "dsh-e2e-session" }, signal: new AbortController().signal };

    const health = String(
      await loaded.tools.get("nmg_daemon")!.execute({ action: "status" }, sessionCtx),
    );
    assert.match(health, /not running/u);

    const savedText = String(
      await loaded.tools.get("nmg_remember")!.execute(
        {
          action: "save",
          statement: "DshE2eMarker persists across CLI fallback processes.",
          nodeName: "DSH E2E",
          memoryType: "fact",
        },
        sessionCtx,
      ),
    );
    const idMatch = savedText.match(/Saved ([0-9a-f]{16,})\b/u);
    assert.ok(idMatch, `Expected saved memory id in: ${savedText}`);
    const savedId = idMatch[1]!;

    const searchText = String(
      await loaded.tools.get("nmg_search")!.execute({ query: "DshE2eMarker" }, sessionCtx),
    );
    assert.match(searchText, new RegExp(`ref:${savedId.slice(0, 4)}\\|`, "u"));
    assert.match(searchText, /DshE2eMarker persists across CLI fallback processes/u);

    const getText = String(
      await loaded.tools.get("nmg_get")!.execute({ memoryIds: [savedId] }, sessionCtx),
    );
    assert.match(getText, /DshE2eMarker persists across CLI fallback processes/u);

    const builtPlugin = resolve(process.cwd(), "dsh/dsh-nmg/lib/index.js");
    if (existsSync(builtPlugin)) {
      const built = await loadPluginTools(builtPlugin, dataDir);
      disposeBuilt = built.dispose;
      assert.equal(built.tools.size, 6);
      for (const tool of built.tools.values()) {
        assertSnapshotJsonSafe(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          `dsh-built:${tool.name}`,
        );
      }
    }
  } finally {
    await disposeBuilt?.();
    await disposeSource?.();
    rmSync(dataDir, { recursive: true, force: true });
    restoreEnv(envBackup);
  }
});
