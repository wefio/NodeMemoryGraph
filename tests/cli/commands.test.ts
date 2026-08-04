import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_KNOWN_FLAGS,
  CLI_KNOWN_OPTIONS,
  cliUsage,
  NMG_CLI_COMMANDS,
} from "../../src/cli/commands.ts";
import { NMG_METHODS, type NmgMethod } from "../../src/cli/protocol.ts";

test("every CLI spec binds a valid RPC method and unique words", () => {
  const methods = new Set<string>(NMG_METHODS);
  const seen = new Set<string>();
  for (const spec of NMG_CLI_COMMANDS) {
    assert.ok(methods.has(spec.method), `${spec.words.join(" ")} has unknown method`);
    const key = spec.words.join(" ");
    assert.ok(!seen.has(key), `duplicate CLI words: ${key}`);
    seen.add(key);
  }
});

test("every RPC method is exposed via the CLI or is intentionally RPC-only", () => {
  // RPC-only: "hello" is the daemon handshake, "shutdown" is driven by
  // `nmg daemon stop` over HTTP — neither has a direct CLI command.
  const rpcOnly: readonly NmgMethod[] = ["hello", "shutdown"];
  const cliMethods = new Set(NMG_CLI_COMMANDS.map((spec) => spec.method));
  for (const method of NMG_METHODS) {
    assert.ok(
      cliMethods.has(method) || rpcOnly.includes(method),
      `${method} is neither a CLI command nor declared RPC-only`,
    );
  }
});

test("USAGE is assembled from the registry", () => {
  const usage = cliUsage(["nmg daemon start|status|stop [--data-dir DIR | --db FILE] [--json]"]);
  for (const spec of NMG_CLI_COMMANDS) {
    assert.ok(usage.includes(spec.usageLine), `USAGE misses ${spec.usageLine}`);
    for (const option of spec.options) {
      assert.ok(CLI_KNOWN_OPTIONS.has(option));
    }
    for (const flag of spec.flags) {
      assert.ok(CLI_KNOWN_FLAGS.has(flag));
    }
  }
});
