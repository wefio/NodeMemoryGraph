import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { parseLocalMemoryHttpConfig } from "../../src/cli/local-memory-http-config.ts";

const fixtureDir = resolve("local-http-config-fixture");
const path = resolve(fixtureDir, "http.json");
const base = { databasePath: "memory.sqlite" };

test("HTTP config resolves relative DB paths and defaults to an unauthenticated loopback listener", () => {
  assert.deepEqual(parseLocalMemoryHttpConfig(base, path, {}), {
    databasePath: resolve(fixtureDir, "memory.sqlite"),
    host: "127.0.0.1",
    port: 8787,
    apiKey: undefined,
    defaultTopK: 20,
    maxRequestBytes: 48 * 1024 * 1024,
  });
});

test("HTTP config honors explicit bind, port zero, search and body budgets, and env-backed auth", () => {
  const databasePath = resolve("another-fixture.sqlite");
  assert.deepEqual(
    parseLocalMemoryHttpConfig(
      {
        databasePath,
        host: "0.0.0.0",
        port: 0,
        defaultTopK: 5,
        maxRequestBytes: 4096,
        apiKeyEnv: "NMG_TEST_HTTP_KEY",
      },
      path,
      { NMG_TEST_HTTP_KEY: "fixture-key" },
    ),
    {
      databasePath,
      host: "0.0.0.0",
      port: 0,
      apiKey: "fixture-key",
      defaultTopK: 5,
      maxRequestBytes: 4096,
    },
  );
});

test("HTTP config refuses unknown fields, invalid limits and an unprotected public bind", () => {
  for (const [value, message] of [
    [null, /JSON object/u],
    [{}, /databasePath/u],
    [{ ...base, listenPort: 9000 }, /Unknown HTTP configuration field: listenPort/u],
    [{ ...base, host: "0.0.0.0" }, /apiKeyEnv is required/u],
    [{ ...base, apiKeyEnv: "MISSING_KEY" }, /variable is empty: MISSING_KEY/u],
    [{ ...base, apiKeyEnv: "not-a-variable" }, /environment variable name/u],
    [{ ...base, port: 65536 }, /port must be an integer/u],
    [{ ...base, defaultTopK: 0 }, /defaultTopK must be an integer/u],
    [{ ...base, maxRequestBytes: "1024" }, /maxRequestBytes must be an integer/u],
  ] as const) {
    assert.throws(() => parseLocalMemoryHttpConfig(value, path, {}), message);
  }
});
