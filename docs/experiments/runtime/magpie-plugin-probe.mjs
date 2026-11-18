import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { privateNmg } from "./native-nmg-fixture.mjs";

const { values } = parseArgs({
  options: {
    "magpie-bin": { type: "string" },
    "bun-bin": { type: "string" },
    plugin: { type: "string" },
    output: { type: "string" },
    hold: { type: "boolean", default: false },
  },
});
if (!values["magpie-bin"] || !values.plugin || !values.output)
  throw new Error(
    "Required --magpie-bin <executable> --plugin <built-plugin-directory> --output <new-evidence-directory>",
  );
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const fixture = join(output, "fixture");
await mkdir(fixture);
const binarySource = resolve(values["magpie-bin"]);
const binary = join(fixture, basename(binarySource));
const home = join(fixture, "home");
await mkdir(home);
await cp(binarySource, binary);
if (binary.endsWith(".com"))
  await cp(binarySource.replace(/\.com$/i, ".exe"), binary.replace(/\.com$/i, ".exe"));
await writeFile(join(fixture, ".portable"), "");
const nmg = await privateNmg(fixture);
const gatewayPort = await availablePort();
const webPort = await availablePort();
const pagePort = await availablePort();
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "appdata"),
  LOCALAPPDATA: join(home, "local"),
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  CODEX_HOME: join(home, "codex"),
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  NMG_DATA_DIR: nmg.dataDirectory,
  MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`,
  MAGPIE_WEB_KEY: "synthetic-private-magpie-web-key",
  ...(values["bun-bin"] ? { MAGPIE_BUN: resolve(values["bun-bin"]) } : {}),
};
const requests = [];
const vendor = createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(body);
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      id: "private-fixture-response",
      object: "chat.completion",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "Atlas uses SQLite storage. NmgNativeExactEvidenceMarker",
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }),
  );
});
await new Promise((done) => vendor.listen(0, "127.0.0.1", done));
let host;
let hostOutput = "";

async function availablePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function command(args, label) {
  try {
    const result = await promisify(execFile)(binary, args, {
      cwd: home,
      env: environment,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(join(output, `${label}.log`), result.stdout + "\n" + result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(
      join(output, `${label}.log`),
      String(error.stdout ?? "") + "\n" + String(error.stderr ?? ""),
    );
    throw error;
  }
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (host?.exitCode !== null && host?.exitCode !== undefined)
      throw new Error("Private Magpie host exited");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return response;
    } catch {
      /* startup */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Private Magpie did not become available at ${url}`);
}

async function rpc(method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp/magpie/tools/nmg`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(65000),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    if (data) result = JSON.parse(data.slice(6));
  }
  assert.ok(response.ok, `${response.status} ${text}`);
  assert.ok(result && !result.error, text);
  return result.result;
}

async function call(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

try {
  const version = (await command(["--version"], "version")).trim();
  await command(
    [
      "provider",
      "add",
      "fixture",
      `url=http://127.0.0.1:${vendor.address().port}/v1`,
      "key=synthetic-vendor-key",
    ],
    "provider",
  );
  await command(["provider", "models", "fixture", "fixture-model"], "models");
  await command(["plugin", "add", resolve(values.plugin)], "install");
  await command(
    [
      "plugin",
      "options",
      "nmg",
      JSON.stringify({
        dataDirectory: nmg.dataDirectory,
        port: pagePort,
        coordination: false,
        gatewayTimeoutMs: 3000,
      }),
    ],
    "options",
  );
  host = spawn(binary, ["web", "--addr", `127.0.0.1:${webPort}`, "--no-open", "--gateway"], {
    cwd: home,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", (chunk) => {
    hostOutput += chunk.toString();
  });
  host.stderr.on("data", (chunk) => {
    hostOutput += chunk.toString();
  });
  await waitFor(`http://127.0.0.1:${gatewayPort}/v1/models`);
  const listed = await rpc("tools/list");
  const names = listed.tools.map((tool) => tool.name);
  for (const name of ["nmg_session", "nmg_search", "nmg_get", "nmg_remember", "nmg_state"])
    assert.ok(names.includes(name), JSON.stringify(names));
  const isolated = JSON.parse(await call("nmg_session", { action: "open" }));
  const search = await call("nmg_search", {
    binding: isolated.handle,
    query: "Atlas SQLite storage",
  });
  assert.match(search, /Atlas|SQLite/);
  await assert.rejects(
    call("nmg_state", { binding: isolated.handle + "tampered", space: "ag", action: "read" }),
  );
  const body = {
    model: "fixture/fixture-model",
    stream: false,
    messages: [
      { role: "user", content: "What did we previously decide about Atlas SQLite storage?" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "original_tool",
          description: "Keep this tool",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/agent/codex/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-session": "native-magpie-fixture-a" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(response.ok, await response.clone().text());
  await response.json();
  const admitted = requests.at(-1);
  assert.ok(admitted, "Private vendor received no request");
  assert.deepEqual(admitted.tools, body.tools);
  assert.ok(
    JSON.stringify(admitted.messages).includes("NmgNativeExactEvidenceMarker"),
    "Automatic recall must reach the vendor",
  );
  assert.ok(
    nmg.requests.some((entry) => entry.method === "search" && entry.params.autoRecall === true),
  );
  assert.ok(JSON.stringify(admitted.messages).includes("NMG_BINDING="), JSON.stringify(admitted));
  const handle = JSON.stringify(admitted.messages).match(/NMG_BINDING=([A-Za-z0-9_.-]+)/)?.[1];
  assert.ok(handle);
  const scope = JSON.parse(await call("nmg_session", { action: "inspect", binding: handle }));
  assert.notEqual(scope.sessionId, isolated.sessionId);
  await call("nmg_state", {
    binding: handle,
    space: "ag",
    action: "write",
    operation: "enable",
    reason: "Maintain private test invariant",
  });
  await call("nmg_state", {
    binding: handle,
    space: "ag",
    action: "write",
    operation: "replace",
    text: "MagpiePrivateOwnerInvariant",
  });
  const resumed = await fetch(`http://127.0.0.1:${gatewayPort}/agent/codex/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-session": "native-magpie-fixture-a" },
    body: JSON.stringify({
      ...body,
      messages: [
        ...body.messages,
        { role: "assistant", content: "Atlas uses SQLite" },
        { role: "user", content: "Continue the Atlas task" },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(resumed.ok, await resumed.clone().text());
  await resumed.json();
  assert.ok(JSON.stringify(requests.at(-1).messages).includes("MagpiePrivateOwnerInvariant"));
  const page = await waitFor(`http://127.0.0.1:${pagePort}/`);
  const frameAncestors = page.headers.get("content-security-policy")
    ?.split(";").map((directive) => directive.trim())
    .find((directive) => directive.startsWith("frame-ancestors "))?.split(/\s+/);
  assert.ok(frameAncestors?.includes("http://wails.localhost"), "Windows Magpie must be able to frame the page");
  assert.ok(!frameAncestors.includes("*"), "Operator page framing must remain restricted");
  const html = await page.text();
  const token = html.match(/NMG_OPERATOR_TOKEN\s*=\s*("[A-Za-z0-9_-]+")/)?.[1];
  assert.ok(token, html.slice(0, 300));
  const snapshot = await fetch(`http://127.0.0.1:${pagePort}/api/snapshot`, {
    headers: { "x-nmg-operator": JSON.parse(token) },
  }).then((value) => value.json());
  assert.ok(snapshot.metrics.counts.memories > 0, JSON.stringify(snapshot));
  const unauthorized = await fetch(`http://127.0.0.1:${pagePort}/api/snapshot`);
  assert.equal(unauthorized.status, 403);
  if (values.hold) {
    await writeFile(
      join(output, "browser-ready.json"),
      JSON.stringify({
        webURL: `http://127.0.0.1:${webPort}/?k=synthetic-private-magpie-web-key`,
        pageURL: `http://127.0.0.1:${pagePort}/`,
        fixture,
      }),
    );
    const until = Date.now() + 600000;
    while (Date.now() < until) {
      if (
        await access(join(output, "continue")).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.ok(Date.now() < until, "Browser verification did not release the private host");
  }
  const summary = {
    measuredAt: new Date().toISOString(),
    version,
    binarySha256: createHash("sha256")
      .update(await readFile(binarySource))
      .digest("hex"),
    bundleSha256: createHash("sha256")
      .update(await readFile(join(resolve(values.plugin), "index.mjs")))
      .digest("hex"),
    tools: names,
    modelRequests: requests.length,
    paidRequests: 0,
    packagedHostExecution: true,
    toolSessionIsolation: true,
    gatewayToolHandoff: true,
    resumedOwnerState: true,
    managementSnapshot: true,
    unauthenticatedManagementRefused: true,
    pagePort,
    webPort,
    gatewayPort,
  };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(JSON.stringify(summary) + "\n");
} finally {
  await writeFile(join(output, "host.log"), hostOutput);
  if (host && host.exitCode === null) {
    if (process.platform === "win32")
      await promisify(execFile)("taskkill", ["/PID", String(host.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined);
    else host.kill("SIGTERM");
  }
  vendor.closeAllConnections();
  await new Promise((done) => vendor.close(done));
  await nmg.close();
  const parent = await realpath(output);
  const target = await realpath(fixture);
  if (relative(parent, target) !== "fixture")
    throw new Error("Unexpected private fixture cleanup target");
  await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
