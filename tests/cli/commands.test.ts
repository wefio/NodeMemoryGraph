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
    const key = spec.words.join(" ");
    if (spec.local) {
      // Local commands (inspect) dispatch directly and must not bind RPC.
      assert.equal(spec.method, undefined, `${key} is local and must not bind an RPC method`);
    } else {
      assert.ok(spec.method && methods.has(spec.method), `${key} has unknown method`);
    }
    assert.ok(!seen.has(key), `duplicate CLI words: ${key}`);
    seen.add(key);
  }
});

test("every RPC method is exposed via the CLI or is intentionally RPC-only", () => {
  // RPC-only: "hello" is the daemon handshake, "shutdown" is driven by
  // `nmg daemon stop` over HTTP — neither has a direct CLI command.
  const rpcOnly: readonly NmgMethod[] = [
    "hello",
    "recordActiveGraphUse",
    "shutdown",
    "stgPurgeSession",
  ];
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

test("CLI exposes explicit resolve and reopen lifecycle operations", () => {
  const resolve = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "resolve")!;
  assert.deepEqual(
    resolve.buildParams({
      flags: new Set(),
      options: new Map([["reason", ["settled"]]]),
      positionals: ["memory-open"],
    }),
    { action: "resolve", memoryId: "memory-open", reason: "settled" },
  );
  const reopen = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "reopen")!;
  assert.deepEqual(
    reopen.buildParams({
      flags: new Set(),
      options: new Map([
        ["related-memory", ["anchor-1", "anchor-2"]],
        ["reason", ["new evidence"]],
      ]),
      positionals: ["memory-open"],
    }),
    {
      action: "reopen",
      memoryId: "memory-open",
      relatedMemoryIds: ["anchor-1", "anchor-2"],
      reason: "new evidence",
    },
  );
});

test("CLI exact get preserves Active Graph use attribution", () => {
  const get = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "get")!;
  assert.deepEqual(
    get.buildParams({
      flags: new Set(),
      options: new Map([["active-graph-id", ["ag-1"]]]),
      positionals: ["memory-1", "memory-2"],
    }),
    { memoryIds: ["memory-1", "memory-2"], activeGraphId: "ag-1" },
  );
});

test("CLI exposes explicit attributable claim outcomes", () => {
  const command = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "claim outcome")!;
  assert.deepEqual(
    command.buildParams({
      flags: new Set(),
      options: new Map([
        ["outcome", ["supported"]],
        ["source", ["tool"]],
        ["source-lineage", ["tool-run:42"]],
        ["semantic-task-id", ["task:42"]],
        ["claim-index", ["0", "2"]],
        ["weight", ["0.8"]],
        ["active-graph-id", ["ag-42"]],
      ]),
      positionals: ["memory-42"],
    }),
    {
      semanticTaskId: "task:42",
      activeGraphId: "ag-42",
      votes: [
        {
          memoryId: "memory-42",
          claimIndexes: [0, 2],
          outcome: "supported",
          source: "tool",
          sourceLineage: "tool-run:42",
          weight: 0.8,
        },
      ],
    },
  );
});
