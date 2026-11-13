// Runs only a built archive, private daemon, private Codex home and local model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { privateNmg } from "./native-nmg-fixture.mjs";
import { readHookCatalog } from "./codex-hook-catalog.mjs";

const { values } = parseArgs({ options: {
  "codex-bin": { type: "string" }, archive: { type: "string" }, output: { type: "string" },
} });
assert.ok(values["codex-bin"] && values.archive && values.output,
  "Required: --codex-bin <exe> --archive <tgz> --output <directory>");
const binary = resolve(values["codex-bin"]);
const archive = resolve(values.archive);
const output = resolve(values.output);
const directory = await mkdtemp(join(tmpdir(), "nmg-codex-distribution-"));
const home = join(directory, "home");
const project = join(directory, "project");
const unpacked = join(directory, "artifact");
const environment = Object.fromEntries(Object.entries(process.env).filter(
  ([key]) => !/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OPENAI_|ANTHROPIC_|NMG_|CODEX_)/i.test(key),
));
Object.assign(environment, { CODEX_HOME: home, NMG_ENABLE_COORDINATION: "0",
  RUST_LOG: "codex_mcp=debug,rmcp=debug",
  NMG_SESSION_ID: "deliberately-wrong-global", NMG_AGENT_ID: "deliberately-wrong-global" });
const invoke = promisify(execFile);
const calls = [];
const stages = new Map();
const toolOutputs = new Map();
let nmg;
let model;

async function run(args, label) {
  try {
    const pending = invoke(binary, args, { cwd: project, env: environment,
      windowsHide: true, timeout: 60000, maxBuffer: 8_000_000 });
    pending.child.stdin.end();
    const result = await pending;
    await writeFile(join(output, `${label}.log`), result.stdout + "\n" + result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(join(output, `${label}.log`), String(error.stdout ?? "") + "\n" + String(error.stderr ?? error));
    throw error;
  }
}

function wireTools(tools, namespace) {
  return (tools ?? []).flatMap((tool) => tool.type === "namespace"
    ? wireTools(tool.tools, tool.name) : [{ ...tool, namespace }]);
}

function respond(response, item) {
  const base = { id: "resp_distribution", object: "response", model: "nmg-probe", output: [] };
  const frame = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  frame("response.created", { response: { ...base, status: "in_progress" } });
  frame("response.output_item.added", { output_index: 0, item });
  frame("response.output_item.done", { output_index: 0, item });
  frame("response.completed", { response: { ...base, status: "completed", output: [item],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
  response.end();
}

function instructions(lane) {
  if (lane === "A" || lane === "B") return [
    ["nmg_state", { action: "write", space: "ag", operation: "enable", reason: "Private isolation test" }],
    ["nmg_state", { action: "write", space: "ag", operation: "replace", text: `Owner${lane}StateMarker\nComplete invariant for ${lane}.` }],
    ["nmg_state", { action: "read", space: "ag" }],
    ["nmg_search", { query: "Atlas SQLite storage" }],
    ["nmg_get", { memoryIds: [nmg.memoryId] }],
    ["nmg_lab", { action: "list" }],
    ["nmg_remember", { action: "save", nodeName: "CodexDistribution", statement: `Saved${lane}Marker` }],
  ];
  return [["nmg_state", { action: "read", space: "ag" }]];
}

async function serve(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await writeFile(join(output, "last-request.json"), JSON.stringify(body, null, 2));
  const user = (body.input ?? []).findLast((item) => item.role === "user" && /NmgLane[ABRF]/.test(JSON.stringify(item)));
  const lane = JSON.stringify(user).match(/NmgLane([ABRF])/)?.[1];
  assert.ok(lane, "Fixture request must name a lane");
  const input = JSON.stringify(body.input);
  const contexts = JSON.stringify((body.input ?? []).filter((item) => ["system", "developer"].includes(item.role)));
  const outputs = (body.input ?? []).filter((item) => item.type === "function_call_output");
  toolOutputs.set(lane, outputs);
  calls.push({ lane, stateA: contexts.includes("OwnerAStateMarker"), stateB: contexts.includes("OwnerBStateMarker"),
    invariantA: contexts.includes("Complete invariant for A."), exact: input.includes("NmgNativeExactEvidenceMarker"),
    skill: input.includes("# NMG Memory") });
  assert.ok(calls.length < 40, "Model request ceiling");
  const stage = stages.get(lane) ?? 0;
  const command = instructions(lane)[stage];
  const tool = command && wireTools(body.tools).find((item) => item.name.endsWith(command[0]));
  if (command) assert.ok(tool, `Missing packaged tool ${command[0]} in ${JSON.stringify(wireTools(body.tools).map((item) => item.name))}`);
  if (tool) {
    stages.set(lane, stage + 1);
    respond(response, { id: `fc_${lane}_${stage}`, type: "function_call", status: "completed",
      call_id: `call_${lane}_${stage}`, name: tool.name, namespace: tool.namespace, arguments: JSON.stringify(command[1]) });
  } else respond(response, { id: `msg_${lane}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: `Done ${lane}`, annotations: [] }] });
}

function threadId(text) {
  const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const started = events.find((item) => item.type === "thread.started");
  assert.ok(started?.thread_id, "Native thread ID missing");
  return started.thread_id;
}

try {
  await Promise.all([home, project, output, unpacked].map((path) => mkdir(path, { recursive: true })));
  await invoke("tar", ["-xzf", archive, "-C", unpacked], { windowsHide: true });
  const plugin = join(unpacked, "package");
  assert.ok(!(await readdir(plugin)).includes("node_modules"));
  nmg = await privateNmg(directory);
  environment.NMG_DATA_DIR = nmg.dataDirectory;
  model = createServer((request, response) => serve(request, response).catch((error) => {
    console.error(error);
    response.writeHead(500); response.end(String(error));
  }));
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  await writeFile(join(home, "config.toml"),
    `model = "nmg-probe"\nmodel_provider = "fixture"\nweb_search = "disabled"\n[features]\nhooks = true\n[model_providers.fixture]\nname = "Private loopback"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  const version = (await run(["--version"], "version")).trim();
  await run(["plugin", "marketplace", "add", plugin, "--json"], "marketplace");
  const installed = JSON.parse(await run(["plugin", "add", "nmg@nmg-local", "--json"], "install"));
  assert.ok(installed.installedPath);
  const pendingInitialize = invoke(process.execPath, [join(installed.installedPath, "scripts", "nmg.mjs"), "mcp"],
    { cwd: project, env: environment, windowsHide: true, timeout: 5000 });
  pendingInitialize.child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "artifact-check", version: "1" } } }) + "\n");
  const initialized = await pendingInitialize;
  await writeFile(join(output, "direct-initialize.log"), initialized.stdout + "\n" + initialized.stderr);
  assert.match(initialized.stdout, /nmg-memory/);
  const config = await readFile(join(home, "config.toml"), "utf8");
  await writeFile(join(home, "config.toml"), config + '\n[plugins."nmg@nmg-local".mcp_servers.nmg]\ndefault_tools_approval_mode = "approve"\n');
  await readHookCatalog({ binary, project, environment, output });
  // Only this reviewed, private fixture bypasses trust. The package does not.
  const prefix = ["--no-daemon", "--dangerously-bypass-hook-trust", "exec"];
  const suffix = ["--skip-git-repo-check", "--json"];
  // Initialize the native DB before testing concurrent launches.
  await run(["--no-daemon", "debug", "--help"], "native-setup");
  const concurrent = await Promise.allSettled([
    run([...prefix, ...suffix, "-s", "read-only", "$nmg:nmg-memory NmgLaneA What did we previously decide about Atlas SQLite storage?"], "chat-a"),
    run([...prefix, ...suffix, "-s", "read-only", "$nmg:nmg-memory NmgLaneB What did we previously decide about Atlas SQLite storage?"], "chat-b"),
  ]);
  for (const result of concurrent) if (result.status === "rejected") throw result.reason;
  const [firstA, firstB] = concurrent.map((result) => result.value);
  const a = threadId(firstA);
  const b = threadId(firstB);
  assert.notEqual(a, b);
  await run([...prefix, "resume", a, ...suffix, "NmgLaneR Preserve the complete owner state."], "resume-a");
  const fork = threadId(await run([...prefix, "fork", a, ...suffix, "NmgLaneF Read this fork's owner AG."], "fork-a"));
  assert.notEqual(fork, a);
  await writeFile(join(output, "model-calls.json"), JSON.stringify(calls, null, 2));
  await writeFile(join(output, "tool-outputs.json"), JSON.stringify(Object.fromEntries(toolOutputs), null, 2));
  await writeFile(join(output, "rpc-requests.json"), JSON.stringify(nmg.requests, null, 2));
  await cp(join(home, "sessions"), join(output, "native-sessions"), { recursive: true });
  await cp(join(nmg.dataDirectory, "codex-sessions"), join(output, "routing"), { recursive: true }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const outputsA = JSON.stringify(toolOutputs.get("A"));
  const outputsB = JSON.stringify(toolOutputs.get("B"));
  const outputsR = JSON.stringify(toolOutputs.get("R"));
  const outputsF = JSON.stringify(toolOutputs.get("F")?.filter((item) => item.call_id === "call_F_0"));
  assert.match(outputsA, /OwnerAStateMarker/);
  assert.doesNotMatch(outputsA, /OwnerBStateMarker/);
  assert.match(outputsB, /OwnerBStateMarker/);
  assert.doesNotMatch(outputsB, /OwnerAStateMarker/);
  assert.match(outputsR, /OwnerAStateMarker/);
  assert.doesNotMatch(outputsF, /OwnerAStateMarker|OwnerBStateMarker/);
  assert.ok(calls.some((call) => call.lane === "R" && call.stateA && call.invariantA), "Resume hook must carry full owner state");
  const sessionRequests = nmg.requests.filter((item) => item.params?.sessionId);
  assert.ok(sessionRequests.some((item) => item.params.sessionId === `codex-${a}`));
  assert.ok(sessionRequests.some((item) => item.params.sessionId === `codex-${b}`));
  assert.ok(sessionRequests.some((item) => item.params.sessionId === `codex-${fork}`));
  assert.ok(nmg.requests.some((item) => item.method === "search" && item.params.autoRecall === true), "Native admission must trigger shared automatic recall");
  assert.ok(sessionRequests.some((item) => item.method === "state" && item.params.operation === "replace"), "Packaged MCP must use the private daemon");
  assert.ok(nmg.requests.some((item) => item.method === "remember" && item.params.statement === "SavedAMarker"));
  assert.ok(sessionRequests.every((item) => item.params.sessionId !== environment.NMG_SESSION_ID));
  const routingFiles = await readdir(join(nmg.dataDirectory, "codex-sessions"));
  assert.ok(routingFiles.includes(`${a}.json`) && routingFiles.includes(`${b}.json`), "Native admission hooks must persist scopes");
  const summary = { measuredAt: new Date().toISOString(), version,
    binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
    archiveSha256: createHash("sha256").update(await readFile(archive)).digest("hex"),
    bundleSha256: createHash("sha256").update(await readFile(join(installed.installedPath, "scripts", "nmg.mjs"))).digest("hex"),
    chats: { a, b, fork }, modelRequests: calls.length, concurrent: true, resumedState: true, forkIsolated: true,
    packagedCacheExecution: true, sourceDependency: false, hookAdmission: true, paidRequests: 0 };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  await cp(join(home, "log"), join(output, "host-log"), { recursive: true }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (model) { model.closeAllConnections(); await new Promise((done) => model.close(done)); }
  await nmg?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
