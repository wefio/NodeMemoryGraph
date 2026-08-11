import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function officialPythonExecutable(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = environment.NMG_BENCHMARK_PYTHON?.trim();
  if (override) return resolve(override);
  return platform === "win32"
    ? resolve(root, ".benchmarks/python/Scripts/python.exe")
    : resolve(root, ".benchmarks/python/bin/python");
}

export function probePython(executable: string): { available: boolean; error: string | null } {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (result.status === 0) return { available: true, error: null };
  return {
    available: false,
    error:
      result.error?.message || result.stderr.trim() || `process exited with status ${result.status}`,
  };
}
