// Probe only: forward stdio unchanged and capture host identity metadata keys.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const record = (entry) => appendFileSync(process.env.NMG_MCP_CAPTURE_LOG, JSON.stringify(entry) + "\n");
record({ environment: Object.keys(process.env).filter((key) => /^(CODEX|MCP)_/.test(key)),
  ids: Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    /^(CODEX|MCP)_.*(?:THREAD|SESSION|TURN)/.test(key) && /^[a-zA-Z0-9_-]{1,100}$/.test(value))),
});
const child = spawn(process.execPath, [process.env.NMG_MCP_SOURCE], {
  env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    record({ method: message.method, paramKeys: Object.keys(message.params ?? {}),
      metadata: message.params?._meta, clientInfo: message.params?.clientInfo,
    });
  }
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
