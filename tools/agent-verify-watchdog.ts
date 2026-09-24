import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let root = process.cwd();
let output: string | undefined;
let timeoutMs = 150_000;
let json = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--root") root = args[++index] ?? root;
  else if (args[index] === "--output") output = args[++index];
  else if (args[index] === "--timeout-ms") {
    const value = args[++index];
    if (value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0)
      timeoutMs = Number(value);
  } else if (args[index] === "--json") json = true;
}
root = resolve(root);
const evidencePath = output
  ? resolve(root, output)
  : resolve(root, ".nmg", "verification", "latest.json");
const startedAt = new Date().toISOString();
const worker = fileURLToPath(new URL("./agent-verify.ts", import.meta.url));
const child = spawnSync(process.execPath, ["--experimental-strip-types", worker, ...args], {
  encoding: "utf8",
  windowsHide: true,
  stdio: json ? "pipe" : "inherit",
  maxBuffer: 16 * 1024 * 1024,
  timeout: timeoutMs,
});
const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
if (!timedOut) {
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) process.stderr.write(`${child.error.message}\n`);
  process.exitCode = child.status ?? 1;
} else {
  const reason = `verification exceeded ${timeoutMs}ms overall deadline; result incomplete`;
  const result = {
    ok: false,
    results: [
      {
        command: "agent:verify",
        classification: "blocking",
        routes: [],
        status: "failed",
        durationMs: timeoutMs,
        reason,
        errorKind: "timeout",
      },
    ],
  };
  const evidence = {
    schemaVersion: 1,
    runId: randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    options: { timeoutMs },
    report: {},
    result,
    incomplete: true,
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  const temporary = `${evidencePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  renameSync(temporary, evidencePath);
  if (json)
    process.stdout.write(`${JSON.stringify({ ...result, incomplete: true, evidencePath })}\n`);
  else process.stderr.write(`${reason}\nEvidence: ${evidencePath}\n`);
  process.exitCode = 1;
}
