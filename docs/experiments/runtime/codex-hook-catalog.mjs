import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function readHookCatalog({ binary, project, environment, output }) {
  const child = spawn(binary, ["--no-daemon", "app-server", "--stdio"], {
    cwd: project,
    env: environment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  child.stderr.resume();
  const request = (method, params) =>
    new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error(`App-server ${method} timed out`)), 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else done(message.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await request("initialize", {
      clientInfo: { name: "nmg_native_probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const result = await request("hooks/list", { cwds: [project] });
    await writeFile(join(output, "hooks-list.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
