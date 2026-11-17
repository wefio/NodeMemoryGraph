import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADAPTER_CAPABILITY_IDS,
  assembleAdapterCapabilities,
  type SharedAdapterTool,
} from "../../src/integration/adapter-capability-assembly.ts";
import {
  ADAPTER_CAPABILITY_CATALOG,
  ADAPTER_MANIFEST_SCHEMA,
  readAdapterManifest,
} from "../../src/integration/adapter-capability-catalog.ts";
import type { SharedStateTool } from "../../src/integration/state-tool.ts";

test("declared subsets use a single native tool registration binding", async () => {
  const registered: string[] = [];
  const bindings = {
    registerTool: (tool: SharedAdapterTool) => {
      registered.push(tool.name);
    },
  };
  assert.throws(
    () => assembleAdapterCapabilities(["search", "automatic-recall"], bindings),
    /automatic-recall: missing native binding/,
  );
  assert.equal(registered.length, 0);
  const assembly = assembleAdapterCapabilities(["search", "get", "remember"], bindings);
  assert.deepEqual(registered, ["nmg_search", "nmg_get", "nmg_remember"]);
  await assembly.ready;
  assert.equal(assembly.describe()[0]?.state, "assembled");
});

test("native bindings receive shared executable context and observation implementations", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const assembly = assembleAdapterCapabilities(["tool-observation"], {
    "tool-observation": ({ observe }) =>
      observe({
        sessionId: "session-a",
        event: { toolName: "write", input: { path: "a.ts" }, content: "ok", isError: false },
        invoke: async (_method, params) => {
          writes.push(params);
        },
      }),
  });
  await assembly.ready;
  assert.equal(writes[0]?.sessionId, "session-a");
  assert.equal(writes[0]?.statement, "Wrote a.ts.");
  assert.equal(writes[0]?.sourceKind, "tool_result");
});

test("disabled features are explicit and do not execute their bindings", async () => {
  const assembly = assembleAdapterCapabilities(["lab"], {}, { disabled: ["lab"] });
  await assembly.ready;
  assert.equal(assembly.describe()[0]?.state, "disabled");
  assert.throws(() => assembleAdapterCapabilities(["lab"], {}), /missing native tool registration/);
});

test("tools intersect their native declaration with the connected daemon", async () => {
  const names: string[] = [];
  const assembly = assembleAdapterCapabilities(
    ["search", "get", "remember", "state.ag", "lab"],
    {
      registerTool: (tool) => {
        names.push(tool.name.slice(4));
      },
    },
    { endpoint: Promise.resolve({ methods: ["search", "remember"] }) },
  );
  await assembly.ready;
  assert.deepEqual(names, ["search", "remember"]);
});

test("failed asynchronous installation rolls back accepted bindings in reverse order", async () => {
  const disposed: string[] = [];
  const assembly = assembleAdapterCapabilities(["search", "get", "remember", "state.ag"], {
    registerTool: (tool) => {
      if (tool.name === "nmg_state") return Promise.reject(new Error("host rejected state"));
      return () => {
        disposed.push(tool.name.slice(4));
      };
    },
  });
  await assert.rejects(
    assembly.ready,
    (error: AggregateError) =>
      error.cause instanceof Error && error.cause.message === "host rejected state",
  );
  assert.deepEqual(disposed, ["remember", "get", "search"]);
  await assembly.dispose();
  assert.equal(disposed.length, 3);
});

test("a disposed assembly releases late registration and stays disposed", async () => {
  let accept!: (cleanup: () => void) => void;
  let releases = 0;
  const assembly = assembleAdapterCapabilities(["completion-nudge"], {
    "completion-nudge": () =>
      new Promise((done) => {
        accept = done;
      }),
  });
  const disposed = assembly.dispose();
  accept(() => {
    releases += 1;
  });
  await disposed;
  await assembly.ready;
  assert.equal(releases, 1);
  assert.equal(assembly.describe()[0]?.state, "disposed");
  await assembly.dispose();
  assert.equal(releases, 1);
});

test("synchronous host rejection stops registration and releases previously accepted tools", async () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      assembleAdapterCapabilities(["search", "get", "remember"], {
        registerTool: (tool) => {
          if (tool.name === "nmg_get") throw new Error("host rejected get");
          return () => {
            calls.push("release search");
          };
        },
      }),
    /host rejected get/,
  );
  assert.deepEqual(calls, ["release search"]);
});

test("shared observation never promotes a failed or no-op commit into a success nudge", async () => {
  let nudges = 0;
  for (const event of [
    { toolName: "bash", input: { command: "git commit" }, content: "failed", isError: true },
    {
      toolName: "bash",
      input: { command: "git commit" },
      content: "nothing to commit",
      isError: false,
    },
    { toolName: "nmg_remember", content: "saved", isError: false },
  ]) {
    const assembly = assembleAdapterCapabilities(["tool-observation"], {
      "tool-observation": ({ observe }) =>
        observe({
          sessionId: "s",
          event,
          invoke: async () => {},
          onCommit: () => {
            nudges += 1;
          },
        }),
    });
    await assembly.ready;
  }
  assert.equal(nudges, 0);
});

test("the manifest schema validates real capability IDs and rejects duplicate or unknown claims", () => {
  const valid = { entry: "fixture.ts", capabilities: ["state.ag"] };
  assert.deepEqual(readAdapterManifest("fixture", valid), valid);
  assert.deepEqual(
    new Set(ADAPTER_MANIFEST_SCHEMA.properties.capabilities.items.enum),
    new Set(ADAPTER_CAPABILITY_IDS),
  );
  for (const input of [
    { ...valid, capabilities: ["state.unknown"] },
    { ...valid, capabilities: ["state.ag", "state.ag"] },
    { ...valid, capabilities: "state.ag" },
    { ...valid, unexpected: true },
  ]) {
    assert.throws(() => readAdapterManifest("fixture", input), /Invalid NMG capability manifest/u);
  }
});

test("the catalog loads through the Pi harness module loader", async () => {
  // Pi loads extensions with jiti, which attaches a non-enumerable,
  // self-referencing `default` to JSON module imports. TypeBox clones and
  // validates own properties, so those wrappers make the catalog overflow the
  // stack before any tool can register.
  const harnessDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const jitiEntry = createRequire(resolve(harnessDir, "index.js")).resolve("jiti");
  const { createJiti } = (await import(pathToFileURL(jitiEntry).href)) as {
    createJiti: (
      url: string,
      options: { moduleCache: boolean },
    ) => {
      import: (
        path: string,
      ) => Promise<typeof import("../../src/integration/adapter-capability-catalog.ts")>;
    };
  };
  const loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
    fileURLToPath(new URL("../../src/integration/adapter-capability-catalog.ts", import.meta.url)),
  );
  assert.deepEqual(loaded.ADAPTER_CAPABILITY_CATALOG, ADAPTER_CAPABILITY_CATALOG);
});

test("state spaces assemble one shared tool and expose only declared operations", async () => {
  for (const [declared, disabled, spaces] of [
    [["state.ag"], [], ["ag"]],
    [["state.board"], [], ["board"]],
    [["state.ag", "state.board"], [], ["ag", "board"]],
    [["state.ag", "state.board"], ["state.board"], ["ag"]],
  ] as const) {
    const tools: SharedStateTool[] = [];
    const assembly = assembleAdapterCapabilities(
      declared,
      {
        registerTool: (tool) => {
          assert.equal(tool.name, "nmg_state");
          tools.push(tool);
        },
      },
      { disabled },
    );
    await assembly.ready;
    assert.equal(tools.length, 1);
    const fields = tools[0]!.inputSchema.properties;
    assert.deepEqual(fields.space.enum, spaces);
    assert.equal(
      fields.operation.enum.includes("enable"),
      (spaces as readonly string[]).includes("ag"),
    );
    assert.equal(
      fields.operation.enum.includes("agentActivity"),
      (spaces as readonly string[]).includes("board"),
    );
  }
});

test("public plugin entry points participate in the executable capability catalog", () => {
  const root = resolve(import.meta.dirname, "../..");
  const entries = Object.values(ADAPTER_CAPABILITY_CATALOG).map((entry) => entry.entry);
  assert.equal(new Set(entries).size, entries.length);
  const discovered: string[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.endsWith("-plugin")) continue;
    for (const file of ["index.ts", "nmg-hook.ts", "nmg-hook.mjs"]) {
      const entry = `${dir.name}/${file}`;
      if (existsSync(resolve(root, entry))) discovered.push(entry);
    }
  }
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  for (const entry of manifest.pi.extensions as string[]) {
    const path = resolve(root, entry);
    const target = readFileSync(path, "utf8").match(/export \{ default \} from "([^"]+)"/);
    assert.ok(target, "Pi public entry must resolve its implementation");
    const resolved = resolve(dirname(path), target[1]!).replaceAll("\\", "/");
    assert.ok(
      entries.some((candidate) => resolved === resolve(root, candidate).replaceAll("\\", "/")),
    );
  }
  for (const dir of readdirSync(resolve(root, "claude-plugins"))) {
    const path = `claude-plugins/${dir}/agents/memory-copilot.ts`;
    if (existsSync(resolve(root, path))) discovered.push(path);
  }
  for (const dir of readdirSync(resolve(root, "dsh"))) {
    const path = `dsh/${dir}/src/plugin/index.ts`;
    if (existsSync(resolve(root, path))) discovered.push(path);
  }
  assert.ok(discovered.length > 0);
  for (const entry of discovered)
    assert.ok(entries.includes(entry), `${entry} has no capability declaration`);
  for (const [id, descriptor] of Object.entries(ADAPTER_CAPABILITY_CATALOG)) {
    const source = readFileSync(resolve(root, descriptor.entry), "utf8");
    assert.ok(
      source.includes(`ADAPTER_CAPABILITY_CATALOG.${id}.capabilities`),
      `${id} does not consume its declaration`,
    );
  }
});
