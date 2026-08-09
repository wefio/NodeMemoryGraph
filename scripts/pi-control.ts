import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";

import { benchmarkCredentialEnvironment } from "../evals/local-env.ts";
import {
  connectDaemon,
  shutdownOwnedDaemon,
  type DaemonConnection,
} from "../src/cli/daemon-client.ts";
import { resolvePiControlPaths } from "./pi-paths.ts";
import { hardTimeout } from "./pi-timeout.ts";

const root = resolve(import.meta.dirname, "..");
const cliPath = resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const extensionPath = resolve(root, ".pi/extensions/nmg/index.ts");
const testModel = process.env.NMG_PI_MODEL || "deepseek/deepseek-v4-flash";
const { agentDirectory, dataDirectory, projectDirectory } = resolvePiControlPaths(root);
const promptTimeoutMs = positiveInteger("NMG_PI_TIMEOUT_MS", 90_000);
const maximumToolCalls = positiveInteger("NMG_PI_MAX_TOOL_CALLS", 12);
let helperDaemon: DaemonConnection | undefined;

const [command, ...args] = process.argv.slice(2);
if (command !== "state" && command !== "prompt") {
  fail("Usage: npm run pi:state | npm run pi:prompt -- <message>");
}

const client = new RpcClient({
  cliPath,
  cwd: root,
  env: definedEnvironment(),
  args: [
    "--offline",
    "--approve",
    "--no-session",
    "--no-extensions",
    "--tools",
    "nmg_remember,nmg_search,nmg_get",
    "--model",
    testModel,
    "--thinking",
    "off",
    "--extension",
    extensionPath,
  ],
});

try {
  // The helper owns daemon lifecycle explicitly. Pi then reuses this endpoint,
  // so a timed-out/killed Pi child cannot orphan a daemon before its extension
  // receives session_shutdown. A daemon that predated the helper is never shut down.
  if (command === "prompt") {
    helperDaemon = await connectDaemon(resolve(dataDirectory, "nmg.sqlite"));
  }
  await client.start();
  let toolCalls = 0;
  let toolLimitExceeded = false;
  const unsubscribe = client.onEvent((event) => {
    if (event.type !== "tool_execution_start") return;
    toolCalls += 1;
    if (toolCalls <= maximumToolCalls || toolLimitExceeded) return;
    toolLimitExceeded = true;
    void client.abort();
  });

  try {
    if (command === "state") {
      const state = await client.getState();
      process.stdout.write(
        `${JSON.stringify(
          {
            model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
            thinkingLevel: state.thinkingLevel,
            sessionId: state.sessionId,
            nmgDatabase: resolve(dataDirectory, "nmg.sqlite"),
            agentDirectory,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const message = args.join(" ").trim();
      if (!message) fail("The prompt message must not be empty.");

      await hardTimeout(promptUntilSettled(client, message), promptTimeoutMs, () => {
        // Do not await abort: the RPC transport itself may be wedged. The
        // outer finally calls client.stop(), which owns only this child.
        void client.abort().catch(() => undefined);
      });
      if (toolLimitExceeded) {
        throw new Error(`Pi exceeded the ${maximumToolCalls}-tool evaluation limit`);
      }
      const response = await client.getLastAssistantText();
      process.stdout.write(`${response ?? ""}\n`);
    }
  } finally {
    unsubscribe();
  }
} catch (error) {
  const stderr = client.getStderr().trim();
  if (stderr) process.stderr.write(`${stderr}\n`);
  throw error;
} finally {
  await client.stop();
  if (helperDaemon) await shutdownOwnedDaemon(helperDaemon);
}

function definedEnvironment(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...benchmarkCredentialEnvironment(root),
    PI_CODING_AGENT_DIR: agentDirectory,
    NMG_DATA_DIR: dataDirectory,
    NMG_PROJECT_DIR: projectDirectory,
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function promptUntilSettled(client: RpcClient, message: string): Promise<void> {
  let unsubscribe = () => undefined;
  const settled = new Promise<void>((resolve) => {
    unsubscribe = client.onEvent((event) => {
      if (event.type === "agent_settled") resolve();
    });
  });

  try {
    await client.prompt(message);
    await settled;
  } finally {
    unsubscribe();
  }
}
