import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const cliPath = resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const extensionPath = resolve(root, ".pi/extensions/nmg/index.ts");
const testModel = process.env.NMG_PI_MODEL || "deepseek/deepseek-v4-flash";

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
  await client.start();

  if (command === "state") {
    const state = await client.getState();
    process.stdout.write(
      `${JSON.stringify(
        {
          model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
          thinkingLevel: state.thinkingLevel,
          sessionId: state.sessionId,
          nmgDatabase: resolve(process.env.NMG_DATA_DIR || resolve(root, ".nmg"), "nmg.sqlite"),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const message = args.join(" ").trim();
    if (!message) fail("The prompt message must not be empty.");

    await client.promptAndWait(message, undefined, 180_000);
    const response = await client.getLastAssistantText();
    process.stdout.write(`${response ?? ""}\n`);
  }
} catch (error) {
  const stderr = client.getStderr().trim();
  if (stderr) process.stderr.write(`${stderr}\n`);
  throw error;
} finally {
  await client.stop();
}

function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
