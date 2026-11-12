// Read-only capability probes against explicitly selected installed hosts.
// Child profiles are disposable; only metadata and synthetic markers are saved.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { exerciseOpenCodeHooks } from "./opencode-hook-exercise.mjs";
import { exerciseDshNmg } from "./dsh-nmg-exercise.mjs";

const { values } = parseArgs({
  options: {
    "dsh-package": { type: "string" },
    "opencode-bin": { type: "string" },
    output: { type: "string" },
    "exercise-hooks": { type: "boolean", default: false },
  },
});
assert.ok(
  values.output && values["dsh-package"] && values["opencode-bin"],
  "Required: --dsh-package <package.json> --opencode-bin <exe> --output <directory>",
);
const output = resolve(values.output);
await mkdir(output, { recursive: true });

const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function probeDsh(packagePath) {
  const require = createRequire(resolve(packagePath));
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
  const { Context } = await load("@deepseek-ai/cordis");
  const { default: SystemPrompt, renderContextSnapshot } = await load(
    "@deepseek-ai/dsh-system-prompt",
  );
  const { default: ToolRuntime, defineTool } = await load("@deepseek-ai/dsh-tools");
  const versions = {};
  for (const name of ["dsh-system-prompt", "dsh-tools", "dsh-agent"]) {
    const path = require.resolve(`@deepseek-ai/${name}/package.json`);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    versions[name] = {
      version: manifest.version,
      sha256: await digest(require.resolve(`@deepseek-ai/${name}`)),
    };
  }
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const states = new Map([
      ["a", "state-a-1"],
      ["b", "state-b-1"],
    ]);
    const dispose = ctx.systemPrompt.context({
      name: "nmg:audit",
      order: 90,
      text: ({ agent }) => states.get(agent?.id) ?? "",
    });
    const first = await ctx.systemPrompt.assemble({ agent: { id: "a" } });
    assert.match(renderContextSnapshot(first), /state-a-1/);
    states.set("a", "state-a-2");
    const refreshed = ctx.systemPrompt.refreshContext(first, { agent: { id: "a" } });
    assert.match(renderContextSnapshot(refreshed), /state-a-2/);
    assert.doesNotMatch(renderContextSnapshot(refreshed), /state-a-1/);
    assert.match(
      renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: { id: "b" } })),
      /state-b-1/,
    );
    dispose();
    assert.doesNotMatch(
      renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: { id: "a" } })),
      /state-a/,
    );
    const events = [];
    ctx.on("tools/result", (exec, result) =>
      events.push({
        callId: exec.callId,
        frozen: Object.isFrozen(result),
        isError: result.isError,
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "nmg_capability_probe",
        description: "Synthetic offline capability probe",
        parameters: { text: { type: "string" } },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args) {
          if (args.text === "fail") throw new Error("synthetic failure");
          return args.text;
        },
      }),
    );
    const signal = new AbortController().signal;
    const success = await ctx.tools.execute({
      signal,
      callId: "audit-success",
      name: "nmg_capability_probe",
      arguments: { text: "ok" },
    });
    const failure = await ctx.tools.execute({
      signal,
      callId: "audit-failure",
      name: "nmg_capability_probe",
      arguments: { text: "fail" },
    });
    assert.equal(success.isError, false);
    assert.equal(failure.isError, true);
    assert.deepEqual(events, [
      { callId: "audit-success", frozen: true, isError: false },
      { callId: "audit-failure", frozen: true, isError: true },
    ]);
    return {
      versions,
      nmg: values["exercise-hooks"] ? await exerciseDshNmg(ctx, renderContextSnapshot) : undefined,
      checks: [
        "dynamic context refresh",
        "context selection by supplied assembly identity",
        "context disposal",
        "final success/error tool-result notifications",
      ],
      notTested: [
        "native Agent lifecycle",
        ...(values["exercise-hooks"] ? [] : ["end-to-end NMG state carriage"]),
        "desktop bundle loading",
        "model/provider calls",
      ],
    };
  } finally {
    await ctx.fiber.dispose();
  }
}

function privateEnvironment(directory) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"),
    OPENCODE_CONFIG_DIR: join(directory, "config"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
}

async function probeOpenCode(binary) {
  const directory = await mkdtemp(join(tmpdir(), "nmg-opencode-audit-"));
  try {
    const { stdout } = await promisify(execFile)(
      binary,
      ["api", "--standalone", "GET", "/openapi.json"],
      {
        cwd: directory,
        env: privateEnvironment(directory),
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 16_000_000,
      },
    );
    const doc = JSON.parse(stdout);
    assert.ok(doc.paths, "Private CLI API must return OpenAPI paths");
    const schemaNames = [
      "Session.Info",
      "Location.PublicRef",
      "Config.InfoEncoded",
      "Config.Plugin.EntryEncoded",
      "Plugin.Info",
      "Plugin.Features",
      "V2EventEncoded",
    ];
    const contract = {
      fullSchemaSha256: createHash("sha256").update(stdout).digest("hex"),
      paths: Object.fromEntries(
        Object.entries(doc.paths).filter(([path]) =>
          /\/api\/(session|event|plugin|config)/.test(path),
        ),
      ),
      schemas: Object.fromEntries(schemaNames.map((name) => [name, doc.components.schemas[name]])),
      note: "Selected schema fragments; unresolved references are intentionally omitted. This is not a replacement SDK.",
    };
    await writeFile(
      join(output, "opencode-contract.json"),
      JSON.stringify(contract, null, 2) + "\n",
    );
    const pluginDirectory = join(directory, "probe-plugin");
    const pluginReceipt = join(directory, "plugin-receipt.json");
    await mkdir(pluginDirectory);
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(
      join(pluginDirectory, "package.json"),
      JSON.stringify({
        name: "nmg-native-capability-probe",
        version: "1.0.0",
        type: "module",
        exports: "./index.ts",
      }),
    );
    await writeFile(
      join(pluginDirectory, "index.ts"),
      `
import { writeFileSync } from "node:fs";
export default { id: "nmg-native-capability-probe", async setup(ctx) {
  const record = { namespaces: Object.keys(ctx), hooks: [], events: [], toolCalls: 0 };
  const save = () => writeFileSync(${JSON.stringify(pluginReceipt)}, JSON.stringify(record));
  save();
  try {
  record.sessionMethods = Object.keys(ctx.session);
  record.toolMethods = Object.keys(ctx.tool); record.eventMethods = Object.keys(ctx.event);
  record.locationKeys = Object.keys(ctx.location);
  for (const name of ["prompt", "context", "compaction"]) {
    await ctx.session.hook(name, async (event) => {
      record.events.push({ name, sessionID: event.sessionID, keys: Object.keys(event) });
      if (name === "prompt") {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        record.sessionLookup = { keys: Object.keys(session), directory: session.location?.directory ?? session.data?.location?.directory };
      }
      if (name === "context") event.messages.push({ role: "system", content: [{ type: "text", text: "NmgNativeHookStateMarker" }] });
      save();
    }); record.hooks.push("session." + name);
  }
  await ctx.tool.hook("execute.after", event => {
    record.events.push({ name: "execute.after", sessionID: event.sessionID, tool: event.tool, keys: Object.keys(event) }); save();
  }); record.hooks.push("tool.execute.after");
  await ctx.tool.transform(editor => editor.add({ name: "audit", description: "Offline synthetic probe",
    input: { type: "object", properties: {} }, execute: async () => { record.toolCalls++; save(); return { content: "NmgNativeToolResultMarker" }; }
  }), { namespace: "nmg_native_probe", codemode: true });
  record.toolTransform = true;
  save();
  } catch (error) { record.error = String(error); save(); throw error; }
} };
`,
    );
    const discoveredPlugins = join(directory, ".opencode", "plugins");
    await mkdir(discoveredPlugins, { recursive: true });
    await writeFile(
      join(discoveredPlugins, "native-audit.ts"),
      await readFile(join(pluginDirectory, "index.ts")),
    );
    await writeFile(
      join(directory, "config", "opencode.json"),
      JSON.stringify({ plugins: [pluginDirectory] }),
    );
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({ plugins: [pluginDirectory] }),
    );
    const config = await promisify(execFile)(
      binary,
      [
        "api",
        "--standalone",
        "GET",
        `/api/config?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      ],
      {
        cwd: directory,
        env: privateEnvironment(directory),
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 1_000_000,
      },
    );
    const configSources = JSON.parse(config.stdout);
    const created = await promisify(execFile)(
      binary,
      [
        "api",
        "--standalone",
        "session.create",
        "--data",
        JSON.stringify({ location: { directory } }),
      ],
      {
        cwd: directory,
        env: privateEnvironment(directory),
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 1_000_000,
      },
    );
    const session = JSON.parse(created.stdout).data;
    assert.ok(session?.id, "Private API must create a synthetic session");
    const loaded = await promisify(execFile)(
      binary,
      ["api", "--standalone", "session.get", "--param", `sessionID=${session.id}`],
      {
        cwd: directory,
        env: privateEnvironment(directory),
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 1_000_000,
      },
    );
    assert.equal(JSON.parse(loaded.stdout).data.location.directory, directory);
    const diagnostic = await promisify(execFile)(
      binary,
      [
        "api",
        "--standalone",
        "GET",
        `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      ],
      {
        cwd: directory,
        env: privateEnvironment(directory),
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 1_000_000,
      },
    );
    const configured = configSources.some((entry) =>
      entry.info?.plugins?.includes(pluginDirectory),
    );
    assert.ok(configured, "Private config must contain the synthetic plugin");
    const exercise = values["exercise-hooks"]
      ? await exerciseOpenCodeHooks({
          binary,
          directory,
          environment: privateEnvironment(directory),
          output,
          pluginReceipt,
        })
      : undefined;
    let plugin;
    try {
      await access(pluginReceipt);
      plugin = JSON.parse(await readFile(pluginReceipt, "utf8"));
      assert.equal(plugin.toolTransform, true);
      assert.deepEqual(plugin.hooks, [
        "session.prompt",
        "session.context",
        "session.compaction",
        "tool.execute.after",
      ]);
      plugin.status = "registered";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      plugin = {
        status: "not-observed",
        configured,
        listedPlugins: JSON.parse(diagnostic.stdout).data.length,
        reason:
          "Standalone API session/config queries did not produce a synthetic plugin setup receipt. Inference-time activation is unverified.",
      };
    }
    return {
      binarySha256: await digest(binary),
      versionFile: (await readFile(join(dirname(binary), "opencode-cli.version"), "utf8")).trim(),
      info: doc.info,
      openapiPath: "/openapi.json",
      plugin,
      exercise,
      sessionLocationBeforePrompt: true,
      operations: Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => ({
          path,
          method,
          id: operation.operationId,
        })),
      ),
      notTested: [
        ...(exercise
          ? ["live external model/provider"]
          : ["model/provider calls", "registered hook invocation during inference"]),
        "fork/reset/reconnect generations and live idle wake",
        "desktop frontend",
      ],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const result = {
  measuredAt: new Date().toISOString(),
  nmgSourceSha256: Object.fromEntries(
    await Promise.all(
      [
        "opencode-plugin/index.ts",
        "dsh/dsh-nmg/src/plugin/index.ts",
        "dsh/dsh-nmg/src/plugin/native-events.ts",
        "docs/experiments/runtime/native-plugin-probe.mjs",
        "docs/experiments/runtime/opencode-hook-exercise.mjs",
        "docs/experiments/runtime/dsh-nmg-exercise.mjs",
        "docs/experiments/runtime/native-nmg-fixture.mjs",
      ].map(async (path) => [path, await digest(resolve(import.meta.dirname, "../../..", path))]),
    ),
  ),
  dsh: await probeDsh(values["dsh-package"]),
  opencode: await probeOpenCode(resolve(values["opencode-bin"])),
};
await writeFile(join(output, "native-plugin-probe.json"), JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify(
    { output, dsh: result.dsh, opencode: { ...result.opencode, operations: undefined } },
    null,
    2,
  ),
);
if (result.opencode.plugin.status !== "registered") process.exitCode = 2;
