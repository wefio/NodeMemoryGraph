import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { officialPythonExecutable } from "./python.ts";

type Upstream = { repository: string; commit: string };

const root = resolve(import.meta.dirname, "../..");
const destination = resolve(root, ".benchmarks", "official");
const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "upstreams.json"), "utf8"),
) as Record<string, Upstream>;

mkdirSync(destination, { recursive: true });
for (const [name, upstream] of Object.entries(manifest)) {
  const directory = resolve(destination, name);
  if (!run("git", ["-C", directory, "rev-parse", "--git-dir"], true)) {
    run("git", ["clone", "--filter=blob:none", upstream.repository, directory]);
  }
  run("git", ["-C", directory, "fetch", "--depth", "1", "origin", upstream.commit]);
  run("git", ["-C", directory, "checkout", "--detach", upstream.commit]);
}

const python = resolve(root, ".benchmarks", "python");
run("uv", ["venv", "--python", "3.11", python]);
const executable = officialPythonExecutable(root, {}, process.platform);
run("uv", ["pip", "install", "--python", executable, "regex", "numpy", "nltk"]);
process.stdout.write(`Official benchmark sources and Python are ready under ${resolve(root, ".benchmarks")}\n`);

function run(command: string, args: string[], probe = false): boolean {
  const result = spawnSync(command, args, { cwd: root, stdio: probe ? "ignore" : "inherit" });
  if (result.status === 0) return true;
  if (probe) return false;
  throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}
