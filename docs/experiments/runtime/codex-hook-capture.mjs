// Optional instrumentation for private native probes with synthetic inputs.
import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
await appendFile(process.env.NMG_PROBE_HOOK_LOG, input.trim() + "\n");
const child = spawn(process.execPath, [process.argv[2], "hook"], {
  windowsHide: true, stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.end(input);
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
