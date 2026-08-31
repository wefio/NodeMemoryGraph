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
  for (const [key, value] of Object.entries(loadEnvironmentFile(file, {}))) {
    if (value !== undefined && BENCHMARK_SECRET_KEYS.has(key)) loaded[key] = value;
  }
  for (const key of BENCHMARK_SECRET_KEYS) {
    const value = environment[key];
    if (value !== undefined) loaded[key] = value;
  }
  return loaded;
}

/** Load a simple shell-style KEY=value file without executing it. File values
 * override the supplied base environment, matching `source benchmark.env`.
 * Command substitution is deliberately unsupported. */
export function loadEnvironmentFile(
  file: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const loaded = { ...environment };
  if (!existsSync(file)) return loaded;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    const key = match[1]!;
    const rawValue = match[2]!;
    if (rawValue.includes("$(") || rawValue.includes("`")) {
      throw new Error(`Environment value ${key} uses unsupported command substitution`);
    }
    loaded[key] = expand(unquote(rawValue), loaded);
  }
  return loaded;
}

function expand(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (_match, braced: string | undefined, plain: string | undefined) =>
      environment[braced ?? plain ?? ""] ?? "",
  );
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
