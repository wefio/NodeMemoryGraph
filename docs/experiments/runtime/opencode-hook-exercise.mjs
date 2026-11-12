import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { privateNmg } from "./native-nmg-fixture.mjs";

async function privateServer(binary, directory, environment) {
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: directory,
    env: {
      ...environment,
      OPENCODE_TEST_HOME: directory,
      OPENCODE_SERVER_PASSWORD: "nmg-private-probe-password",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Private HTTP host startup timed out: " + log)),
      15000,
    );
    const append = (chunk) => {
      log = (log + chunk).slice(-16000);
      const url = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Private HTTP host exited " + code + ": " + log));
    });
  });
  return { child, ready, log: () => log };
}

async function clientFor(url) {
  const password = "nmg-private-probe-password";
  for (const authorization of [
    "Basic " + Buffer.from("opencode:" + password).toString("base64"),
    "Bearer " + password,
  ]) {
    const response = await fetch(url + "/openapi.json", {
      headers: { authorization },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) continue;
    return async (path, body) => {
      const response = await fetch(url + path, {
        method: body ? "POST" : "GET",
        headers: { authorization, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      assert.ok(response.ok, `Private API ${path}: ${JSON.stringify(result)}`);
      return result;
    };
  }
  throw new Error("Private host did not accept its synthetic password");
}

async function compactNative(api, sessionId, pluginReceipt) {
  await api(`/api/session/${sessionId}/compact`, {});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const receipt = await readFile(pluginReceipt, "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (receipt?.events.some((event) => event.name === "compaction")) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Native compaction did not invoke the registered hook");
}

/** Drive the installed host against a loopback model; no provider keys are used. */
export async function exerciseOpenCodeHooks({
  binary,
  directory,
  environment,
  output,
  pluginReceipt,
}) {
  const nmg = await privateNmg(directory);
  const calls = [];
  const summarize = () =>
    calls.map((call) => ({
      path: call.path,
      keys: Object.keys(call.body),
      stateMarker: JSON.stringify(call.body.messages).includes("NmgNativeHookStateMarker"),
      toolResult: call.body.messages?.some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("NmgNativeToolResultMarker"),
      ),
      maintainedState: call.body.messages?.some(
        (message) =>
          ["system", "user"].includes(message.role) &&
          /(?:<|&lt;)nmg_working_state(?:>|&gt;)/.test(JSON.stringify(message.content)) &&
          JSON.stringify(message.content).includes("Preserve the entire invariant."),
      ),
      exactEvidence: call.body.messages?.some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("NmgNativeExactEvidenceMarker"),
      ),
      tools: call.body.tools?.map((tool) => tool.function?.name),
      afterCompaction: call.body.messages?.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("NmgNativeAfterCompactionMarker"),
      ),
    }));
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push({ path: request.url, body });
      const main = JSON.stringify(body.messages).includes("NmgNativeHookStateMarker");
      const hasResult = body.messages?.some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("NmgNativeToolResultMarker"),
      );
      const names = body.tools?.map((tool) => tool.function?.name) ?? [];
      const codeTool = names.find((name) => /run_code|execute|codemode/.test(name));
      const directTool = names.find((name) => /audit/.test(name));
      const toolCall = main && !hasResult && (codeTool || directTool);
      const frame = {
        id: "nmg-native-hook-probe",
        object: "chat.completion.chunk",
        created: 1,
        model: "probe",
        choices: [
          {
            index: 0,
            delta: toolCall
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "nmg-probe-call",
                      type: "function",
                      function: {
                        name: codeTool ?? directTool,
                        arguments: JSON.stringify(
                          codeTool
                            ? {
                                code: `
            const header = await tools.nmg_search({query: "Atlas SQLite storage"});
            const evidence = await tools.nmg_get({memoryIds: [${JSON.stringify(nmg.memoryId)}]});
            const enabled = await tools.nmg_state({space: "ag", action: "write", operation: "enable", reason: "Native probe"});
            const replaced = await tools.nmg_state({space: "ag", action: "write", operation: "replace", text: ${JSON.stringify("NmgNativeMaintainedStateMarker\nPreserve the entire invariant.")}});
            return {marker: "NmgNativeToolResultMarker", header, evidence, enabled, replaced};
          `,
                              }
                            : {},
                        ),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "NmgNativeHookProbe complete" },
            finish_reason: null,
          },
        ],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
      frame.choices = [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }];
      response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  let host;
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const configPath = join(directory, "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.plugins = [join(import.meta.dirname, "../../../opencode-plugin"), ...config.plugins];
    Object.assign(config, {
      model: "nmg-probe/probe",
      compaction: { auto: false },
      agents: { build: { steps: 4 } },
      providers: {
        "nmg-probe": {
          name: "Loopback probe",
          package: "@ai-sdk/openai-compatible",
          env: [],
          settings: { baseURL, apiKey: "synthetic-loopback-only" },
          models: {
            probe: {
              name: "probe",
              limit: { context: 1000000, output: 1024 },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
            },
          },
        },
      },
    });
    await writeFile(configPath, JSON.stringify(config));
    host = await privateServer(binary, directory, {
      ...environment,
      NMG_DATA_DIR: nmg.dataDirectory,
      NMG_ENABLE_COORDINATION: "0",
      NMG_PROJECT_DIR: "",
    });
    const api = await clientFor(await host.ready);
    const session = (
      await api("/api/session", {
        location: { directory },
        model: { id: "probe", providerID: "nmg-probe" },
      })
    ).data;
    await api(`/api/session/${session.id}/prompt`, {
      text: "What did we previously decide about Atlas SQLite storage? NmgNativeHookProbe",
    });
    let outcome;
    let compactionHook = false;
    for (let turn = 0; turn < 3; turn++) {
      const before = calls.length;
      if (turn === 2) {
        compactionHook = await compactNative(api, session.id, pluginReceipt);
      }
      if (turn)
        await api(`/api/session/${session.id}/prompt`, {
          text:
            turn === 1
              ? "NmgNativeHookProbe second turn, retain the current working state."
              : "NmgNativeAfterCompactionMarker, retain the current working state.",
        });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        outcome = (await api(`/api/session/${session.id}`)).data.outcome;
        if (
          outcome &&
          (!turn ||
            calls
              .slice(before)
              .some((call) =>
                call.body.messages?.some(
                  (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes(
                      turn === 1 ? "second turn" : "NmgNativeAfterCompactionMarker",
                    ),
                ),
              ))
        )
          break;
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.equal(outcome, "succeeded");
    }
    await writeFile(join(output, "opencode-hook-exercise.txt"), host.log());
    const requestSummary = summarize();
    await writeFile(
      join(output, "opencode-hook-exercise-calls.json"),
      JSON.stringify(requestSummary, null, 2),
    );
    assert.ok(
      requestSummary.some((call) => call.stateMarker),
      "Context hook marker must reach the loopback model",
    );
    assert.ok(
      requestSummary.some((call) => call.toolResult),
      "Tool execution result must reach a subsequent request",
    );
    assert.ok(
      requestSummary.some((call) => call.maintainedState),
      "NMG maintained state must reach a subsequent prompt request",
    );
    assert.ok(
      requestSummary.some((call) => call.afterCompaction && call.maintainedState),
      "Current state must be carried after native compaction",
    );
    assert.ok(
      requestSummary.some((call) => call.exactEvidence),
      "NMG exact evidence must reach the loopback model",
    );
    assert.ok(
      nmg.requests.some((call) => call.method === "get"),
      "Native NMG exact get must run",
    );
    const firstSearch = nmg.requests.find((call) => call.method === "search");
    assert.equal(
      firstSearch?.params.projectDir,
      directory,
      "First-turn recall uses the native project directory",
    );
    assert.equal(outcome, "succeeded");
    return {
      compactionHook,
      calls: requestSummary,
      outcome,
      nmgMethods: [...new Set(nmg.requests.map((call) => call.method))],
    };
  } catch (error) {
    await writeFile(
      join(output, "opencode-hook-exercise.txt"),
      (host?.log() ?? "") + "\n" + String(error),
    );
    await writeFile(
      join(output, "opencode-hook-exercise-calls.json"),
      JSON.stringify(summarize(), null, 2),
    );
    throw error;
  } finally {
    if (host?.child.exitCode === null) {
      host.child.kill();
      await new Promise((done) => host.child.once("exit", done));
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await nmg.close();
    await writeFile(join(output, "opencode-nmg-rpc.json"), JSON.stringify(nmg.requests, null, 2));
  }
}
