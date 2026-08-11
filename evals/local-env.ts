import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const BENCHMARK_SECRET_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
]);

/**
 * Load only benchmark model credentials from the repository-local ignored
 * `.env`. Values are never logged and an already exported process value wins.
 */
export function benchmarkCredentialEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const file = resolve(root, ".env");
  const loaded: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
      if (!match || !BENCHMARK_SECRET_KEYS.has(match[1]!)) continue;
      loaded[match[1]!] = unquote(match[2]!);
    }
  }
  for (const key of BENCHMARK_SECRET_KEYS) {
    const value = environment[key];
    if (value !== undefined) loaded[key] = value;
  }
  return loaded;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
