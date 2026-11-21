import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DEFAULT_EXPLICIT_SEARCH_LIMIT } from "../integration/explicit-search-page.ts";
import { isJsonObject, type JsonObject } from "../integration/memory-http-protocol.ts";

export interface LocalMemoryHttpConfig {
  host: string;
  port: number;
  databasePath: string;
  apiKey?: string;
  defaultTopK: number;
  maxRequestBytes: number;
}

function integerOption(
  config: JsonObject,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = config[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}

export async function readLocalMemoryHttpConfig(path: string): Promise<LocalMemoryHttpConfig> {
  return parseLocalMemoryHttpConfig(JSON.parse(await readFile(path, "utf8")), path);
}

export function parseLocalMemoryHttpConfig(
  config: unknown,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalMemoryHttpConfig {
  if (!isJsonObject(config)) throw new Error("HTTP config must be a JSON object");
  const allowed = ["host", "port", "databasePath", "apiKeyEnv", "defaultTopK", "maxRequestBytes"];
  const unknown = Object.keys(config).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown HTTP configuration field: ${unknown}`);
  if (typeof config.databasePath !== "string" || !config.databasePath.trim())
    throw new Error("databasePath must name a file-backed SQLite database");
  const host = config.host ?? "127.0.0.1";
  if (typeof host !== "string" || !host.trim()) throw new Error("host must be a nonempty string");
  const apiKey = configuredApiKey(config.apiKeyEnv, env);
  if (!apiKey && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("apiKeyEnv is required for a non-loopback HTTP listener");

  return {
    host,
    apiKey,
    databasePath: resolve(dirname(path), config.databasePath),
    port: integerOption(config, "port", 8787, 0, 65535),
    defaultTopK: integerOption(config, "defaultTopK", DEFAULT_EXPLICIT_SEARCH_LIMIT, 1, 100),
    maxRequestBytes: integerOption(config, "maxRequestBytes", 6 * 1024 * 1024, 1, 6 * 1024 * 1024),
  };
}

function configuredApiKey(name: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (name === undefined) return;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
    throw new Error("apiKeyEnv must be an environment variable name");
  const key = env[name];
  if (!key?.trim()) throw new Error(`HTTP API key environment variable is empty: ${name}`);
  return key;
}
