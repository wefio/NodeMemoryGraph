// Native Codex plugin installation and execution against private, local fixtures.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readHookCatalog } from "./codex-hook-catalog.mjs";
import { parseArgs, promisify } from "node:util";
import { privateNmg } from "./native-nmg-fixture.mjs";

const { values } = parseArgs({
  options: {
    "codex-bin": { type: "string" },
    output: { type: "string" },
    layout: { type: "string", default: "compatibility" },
    "capture-mcp": { type: "boolean", default: false },
  },
});
assert.ok(values["codex-bin"] && values.output, "Required: --codex-bin <exe> --output <directory>");
assert.ok(
  ["portable", "overlay", "compatibility"].includes(values.layout),
  "Invalid manifest layout",
);
const binary = resolve(values["codex-bin"]);
const output = resolve(values.output);
const root = resolve(import.meta.dirname, "../../..");
const directory = await mkdtemp(join(tmpdir(), "nmg-native-codex-"));
await mkdir(output, { recursive: true });
let nmg;
let model;
const modelCalls = [];
let stage = 0;
const invoke = promisify(execFile);
const home = join(directory, "codex-home");
const project = join(directory, "project");
const hookLog = join(directory, "hooks.jsonl");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OPENAI_|ANTHROPIC_|NMG_|CODEX_)/i.test(key),
  ),
);
// CODEX_HOME retains its intended meaning, scoped to these child processes.
Object.assign(environment, { CODEX_HOME: home, NMG_ENABLE_COORDINATION: "0" });
const run = async (args, label) => {
  try {
    const pending = invoke(binary, args, {
      cwd: project,
      env: environment,
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 8_000_000,
    });
    pending.child.stdin.end();
    const result = await pending;
    await writeFile(join(output, `${label}.log`), result.stdout + "\n" + result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(
      join(output, `${label}.log`),
      String(error.stdout ?? "") + "\n" + String(error.stderr ?? error),
    );
    throw error;
  }
};

function wireTools(tools, namespace) {
  return (tools ?? []).flatMap((tool) =>
    tool.type === "namespace" ? wireTools(tool.tools, tool.name) : [{ ...tool, namespace }],
  );
}

function sendResponse(response, item) {
  const base = { id: "resp_nmg_probe", object: "response", model: "nmg-probe", output: [] };
  const frame = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  frame("response.created", { response: { ...base, status: "in_progress" } });
  frame("response.output_item.added", { output_index: 0, item });
  frame("response.output_item.done", { output_index: 0, item });
  frame("response.completed", {
    response: {
      ...base,
      status: "completed",
      output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    },
  });
  response.end();
}


try {
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  nmg = await privateNmg(directory);
  Object.assign(environment, {
    NMG_DATA_DIR: nmg.dataDirectory,
    NMG_SESSION_ID: "codex-native-probe-session",
    NMG_PROBE_HOOK_LOG: hookLog,
  });
  const commands = [
    ["nmg_search", { query: "Atlas SQLite storage" }],
    ["nmg_get", { memoryIds: [nmg.memoryId] }],
    [
      "nmg_state",
      { action: "write", space: "ag", operation: "enable", reason: "Private native probe" },
    ],
    [
      "nmg_state",
      {
        action: "write",
        space: "ag",
        operation: "replace",
        text: "NmgCodexMaintainedStateMarker\nPreserve the complete invariant.",
      },
    ],
  ];
  commands.push(
    [
      "nmg_remember",
      { action: "save", statement: "NmgCodexSavedByPluginMarker", nodeName: "CodexPluginProbe" },
    ],
    ["nmg_lab", { action: "list" }],
  );
  model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const tools = wireTools(body.tools);
    const contexts = JSON.stringify(
      (body.input ?? []).filter((item) => ["system", "developer"].includes(item.role)),
    );
    const toolOutputs = (body.input ?? []).filter((item) => item.type === "function_call_output");
    modelCalls.push({
      path: request.url,
      toolNames: tools.map((tool) => [tool.namespace, tool.name].filter(Boolean).join(".")),
      hook: contexts.includes("NmgCodexPluginHookMarker"),
      state: contexts.includes("NmgCodexMaintainedStateMarker"),
      completeState:
        contexts.includes("NmgCodexMaintainedStateMarker") &&
        contexts.includes("Preserve the complete invariant."),
      exact: JSON.stringify(toolOutputs).includes("NmgNativeExactEvidenceMarker"),
      skill: JSON.stringify(body.input).includes("# NMG Memory"),
      outputs: toolOutputs.map((item) => item.call_id),
    });
    if (modelCalls.length > 15) {
      response.writeHead(500);
      response.end("Probe call ceiling");
      return;
    }
    const command = commands[stage];
    const tool = command && tools.find((tool) => tool.name.endsWith(command[0]));
    if (tool) {
      const call = stage++;
      sendResponse(response, {
        id: `fc_probe_${call}`,
        type: "function_call",
        status: "completed",
        call_id: `call_probe_${call}`,
        name: tool.name,
        namespace: tool.namespace,
        arguments: JSON.stringify(command[1]),
      });
    } else {
      sendResponse(response, {
        id: "msg_probe_final",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "NmgCodexPluginProbeComplete", annotations: [] }],
      });
    }
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const baseURL = `http://127.0.0.1:${model.address().port}/v1`;
  await writeFile(
    join(home, "config.toml"),
    `model = "nmg-probe"\nmodel_provider = "nmg_probe"\nweb_search = "disabled"\n[features]\nhooks = true\n[model_providers.nmg_probe]\nname = "Private loopback fixture"\nbase_url = "${baseURL}"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,
  );
  const plugin = join(project, "plugins", "nmg-native-probe");
  await mkdir(join(plugin, "hooks"), { recursive: true });
  await cp(join(root, "skills", "nmg-memory"), join(plugin, "skills", "nmg-memory"), {
    recursive: true,
  });
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "nmg-native-probe",
      version: "0.0.1",
      description: "Private source-bound NMG native-host probe",
      extensions: { "com.openai": { hooks: "./hooks/hooks.json" } },
    }),
  );
  if (values.layout !== "portable") {
    await mkdir(join(plugin, ".codex-plugin"));
    await writeFile(
      join(plugin, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "nmg-native-probe",
        version: "0.0.1",
        description: "Private source-bound NMG native-host probe",
      }),
    );
    await writeFile(
      join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "nmg-native-probe",
        version: "0.0.1",
        description: "Private source-bound native NMG probe",
        author: { name: "NMG" },
        hooks: "./hooks/hooks.json",
        skills: "./skills/",
        mcpServers: "./.mcp.json",
      }),
    );
  }
  await writeFile(
    join(plugin, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        nmg: {
          type: "stdio",
          command: "node",
          args: [
            "--experimental-strip-types",
            values["capture-mcp"]
              ? join(import.meta.dirname, "codex-mcp-capture.mjs")
              : join(root, "claude-plugins/nmg-memory/agents/memory-copilot.ts"),
          ],
          env: {
            NMG_DATA_DIR: nmg.dataDirectory,
            NMG_SESSION_ID: environment.NMG_SESSION_ID,
            NMG_ENABLE_COORDINATION: "0",
            ...(values["capture-mcp"] ? {
              NMG_MCP_SOURCE: join(root, "claude-plugins/nmg-memory/agents/memory-copilot.ts"),
              NMG_MCP_CAPTURE_LOG: join(output, "mcp-host-metadata.jsonl"),
            } : {}),
          },
        },
      },
    }),
  );
  if (values.layout !== "portable") await cp(join(plugin, "mcp.json"), join(plugin, ".mcp.json"));
  if (values.layout === "compatibility") await rm(join(plugin, "plugin.json"));
  await writeFile(
    join(plugin, "hooks", "run.mjs"),
    `import ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "codex-probe-hook.mjs")).href)};\n`,
  );
  await writeFile(
    join(plugin, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map((event) => [
          event,
          [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "${PLUGIN_ROOT}/hooks/run.mjs"',
                  timeout: 5,
                  ...(event === "Stop" ? {} : { additionalContextLimit: 0 }),
                },
              ],
            },
          ],
        ]),
      ),
    }),
  );
  await mkdir(join(project, ".agents", "plugins"), { recursive: true });
  await writeFile(
    join(project, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "nmg-native-market",
      plugins: [
        {
          name: "nmg-native-probe",
          source: { source: "local", path: "./plugins/nmg-native-probe" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),
  );
  const version = (await run(["--version"], "version")).trim();
  await run(["plugin", "marketplace", "add", project, "--json"], "marketplace");
  const installed = JSON.parse(
    await run(["plugin", "add", "nmg-native-probe@nmg-native-market", "--json"], "install"),
  );
  const packageFiles = {};
  for (const file of ["plugin.json", ".codex-plugin/plugin.json", "hooks/hooks.json"]) {
    packageFiles[file] = await readFile(join(installed.installedPath, file), "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
  }
  await writeFile(join(output, "installed-package.json"), JSON.stringify(packageFiles, null, 2));
  const configPath = join(home, "config.toml");
  const installedConfig = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    installedConfig +
      '\n[plugins."nmg-native-probe@nmg-native-market".mcp_servers.nmg]\ndefault_tools_approval_mode = "approve"\n',
  );
  await run(["features", "list"], "features");
  await readHookCatalog({ binary, project, environment, output });
  const listed = JSON.parse(
    await run(["plugin", "list", "--marketplace", "nmg-native-market", "--json"], "plugins"),
  );
  const first = await run(
    [
      "--no-daemon",
      "--dangerously-bypass-hook-trust",
      "exec",
      "--skip-git-repo-check",
      "--json",
      "-s",
      "read-only",
      "$nmg-memory What did we previously decide about Atlas SQLite storage?",
    ],
    "first-turn",
  );
  const started = first
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    })
    .find((item) => item.type === "thread.started");
  assert.ok(started?.thread_id, "Native Codex must start a thread");
  await run(
    [
      "--no-daemon",
      "--dangerously-bypass-hook-trust",
      "exec",
      "resume",
      started.thread_id,
      "--skip-git-repo-check",
      "--json",
      "Continue this same probe; preserve the maintained state.",
    ],
    "second-turn",
  );
  const hookText = await readFile(hookLog, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const hooks = hookText
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const summary = {
    measuredAt: new Date().toISOString(),
    version,
    layout: values.layout,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    sourceSha256: Object.fromEntries(
      await Promise.all(
        [
          "docs/experiments/runtime/codex-plugin-probe.mjs",
          "docs/experiments/runtime/codex-probe-hook.mjs",
          "src/integration/adapter-capability-assembly.ts",
          "src/integration/adapter-capability-catalog.ts",
          "claude-plugins/nmg-memory/agents/memory-copilot.ts",
        ].map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(join(root, path)))
            .digest("hex"),
        ]),
      ),
    ),
    listed,
    modelCalls,
    hooks,
    rpcMethods: nmg.requests.map((request) => ({
      method: request.method,
      action: request.params?.action,
      operation: request.params?.operation,
    })),
  };
  await writeFile(join(output, "codex-plugin-probe.json"), JSON.stringify(summary, null, 2) + "\n");
  assert.equal(stage, commands.length, "All real NMG tool calls must execute through the plugin");
  assert.ok(
    nmg.requests.some((call) => call.method === "get"),
    "NMG exact get must execute",
  );
  assert.ok(
    nmg.requests.some((call) => call.method === "state" && call.params.operation === "replace"),
    "NMG state replacement must execute",
  );
  assert.ok(
    modelCalls.some((call) => call.hook),
    "Plugin hook context must reach the loopback receiver",
  );
  assert.ok(
    modelCalls.some((call) => call.skill),
    "The packaged NMG Skill must reach the model request",
  );
  assert.ok(
    modelCalls.some((call) => call.exact),
    "Exact evidence must reach a subsequent model request",
  );
  assert.ok(
    modelCalls.some((call) => call.completeState),
    "Complete state must reach the resumed user turn",
  );
  assert.ok(
    nmg.requests.some((call) => call.method === "remember"),
    "NMG remember must execute",
  );
  assert.ok(
    nmg.requests.some((call) => call.method === "lab"),
    "NMG Lab listing must execute",
  );
  assert.ok(
    hooks.some((hook) => hook.event === "PostToolUse"),
    "Native post-tool hook must execute",
  );
  process.stdout.write(String(JSON.stringify({
      output,
      version,
      requests: modelCalls.length,
      checks: [
        "native plugin installation",
        "NMG tools",
        "plugin hook context",
        "exact evidence",
        "resumed state carriage",
        "post-tool hook",
      ],
    })) + "\n");
} finally {
  await writeFile(join(output, "model-calls.json"), JSON.stringify(modelCalls, null, 2) + "\n");
  if (model) {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }
  await nmg?.close();
  await rm(directory, { recursive: true, force: true });
}
