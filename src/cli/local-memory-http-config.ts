import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { NmgLayerConfig } from "../core/capability-config.ts";
import { DEFAULT_EXPLICIT_SEARCH_LIMIT } from "../integration/explicit-search-page.ts";
import { isJsonObject, type JsonObject } from "../integration/memory-http-protocol.ts";
import { resolveEffectiveNmgConfig } from "../integration/runtime-config.ts";

export interface LocalMemoryHttpConfig {
  host: string;
  port: number;
  databasePath: string;
  apiKey?: string;
  defaultTopK: number;
  maxRequestBytes: number;
  searchPreviewCodePoints?: number;
  searchMaxCharacters?: number;
  preprocessMessages?: boolean;
  sortResultsByTime?: boolean;
  /** Optional L2 adapter overrides layered over shared L1 config. */
  l2Overrides?: NmgLayerConfig;
  effectiveConfigIdentity?: string;
}

const MAX_LOCAL_REQUEST_BYTES = 48 * 1024 * 1024;

function optionalIntegerOption(
  config: JsonObject,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}

function optionalBooleanOption(config: JsonObject, key: string): boolean | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
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

function parseHttpOptionalOptions(config: JsonObject): Partial<LocalMemoryHttpConfig> {
  const searchPreviewCodePoints = optionalIntegerOption(
    config,
    "searchPreviewCodePoints",
    0,
    100_000,
  );
  const searchMaxCharacters = optionalIntegerOption(config, "searchMaxCharacters", 256, 1_000_000);
  const preprocessMessages = optionalBooleanOption(config, "preprocessMessages");
  const sortResultsByTime = optionalBooleanOption(config, "sortResultsByTime");
  return {
    ...(searchPreviewCodePoints !== undefined ? { searchPreviewCodePoints } : {}),
    ...(searchMaxCharacters !== undefined ? { searchMaxCharacters } : {}),
    ...(preprocessMessages !== undefined ? { preprocessMessages } : {}),
    ...(sortResultsByTime !== undefined ? { sortResultsByTime } : {}),
  };
}

export function parseLocalMemoryHttpConfig(
  config: unknown,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalMemoryHttpConfig {
  if (!isJsonObject(config)) throw new Error("HTTP config must be a JSON object");
  const allowed = [
    "host",
    "port",
    "databasePath",
    "apiKeyEnv",
    "defaultTopK",
    "maxRequestBytes",
    "searchPreviewCodePoints",
    "searchMaxCharacters",
    "preprocessMessages",
    "sortResultsByTime",
    "bindings",
    "runtime",
    "allowAlgorithmicOverrides",
    "allowedAlgorithmicVariants",
  ];
  const unknown = Object.keys(config).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown HTTP configuration field: ${unknown}`);
  if (typeof config.databasePath !== "string" || !config.databasePath.trim())
    throw new Error("databasePath must name a file-backed SQLite database");
  const host = config.host ?? "127.0.0.1";
  if (typeof host !== "string" || !host.trim()) throw new Error("host must be a nonempty string");
  const apiKey = configuredApiKey(config.apiKeyEnv, env);
  if (!apiKey && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("apiKeyEnv is required for a non-loopback HTTP listener");

  const l2Overrides = extractHttpL2Overrides(config);
  const resolved = resolveEffectiveNmgConfig({
    l2: l2Overrides,
    l2Source: path,
    environment: env,
    dataDir: dirname(resolve(dirname(path), config.databasePath)),
  });

  const result: LocalMemoryHttpConfig = {
    host,
    apiKey,
    databasePath: resolve(dirname(path), config.databasePath),
    port: integerOption(config, "port", 8787, 0, 65535),
    defaultTopK: integerOption(config, "defaultTopK", DEFAULT_EXPLICIT_SEARCH_LIMIT, 1, 100),
    maxRequestBytes: integerOption(
      config,
      "maxRequestBytes",
      MAX_LOCAL_REQUEST_BYTES,
      1,
      MAX_LOCAL_REQUEST_BYTES,
    ),
    ...parseHttpOptionalOptions(config),
    ...(l2Overrides ? { l2Overrides } : {}),
  };
  Object.defineProperty(result, "effectiveConfigIdentity", {
    value: resolved.resultIdentityHash,
    enumerable: false,
    configurable: true,
  });
  return result;
}

function extractHttpL2Overrides(config: JsonObject): NmgLayerConfig | undefined {
  const hasLayerFields =
    config.bindings !== undefined ||
    config.runtime !== undefined ||
    config.allowAlgorithmicOverrides !== undefined ||
    config.allowedAlgorithmicVariants !== undefined;
  if (!hasLayerFields) return undefined;
  if (config.runtime !== undefined && !isJsonObject(config.runtime)) {
    throw new Error("runtime configuration must be an object");
  }
  if (config.bindings !== undefined && !isJsonObject(config.bindings)) {
    throw new Error("bindings configuration must be an object");
  }
  return {
    ...(isJsonObject(config.bindings)
      ? { bindings: config.bindings as NmgLayerConfig["bindings"] }
      : {}),
    ...(isJsonObject(config.runtime)
      ? { runtime: config.runtime as NmgLayerConfig["runtime"] }
      : {}),
    ...(typeof config.allowAlgorithmicOverrides === "boolean"
      ? { allowAlgorithmicOverrides: config.allowAlgorithmicOverrides }
      : {}),
    ...(Array.isArray(config.allowedAlgorithmicVariants)
      ? { allowedAlgorithmicVariants: config.allowedAlgorithmicVariants.map(String) }
      : {}),
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
