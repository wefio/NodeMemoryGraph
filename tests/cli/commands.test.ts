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
    "recordActiveGraphAttribution",
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

test("CLI exact get preserves Active Graph disclosure attribution", () => {
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

test("CLI remember attributes the submission channel to the user by default", () => {
  const command = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "remember")!;
  assert.deepEqual(
    command.buildParams({
      flags: new Set(),
      options: new Map([["node", ["Atlas storage"]]]),
      positionals: ["Atlas", "uses", "SQLite."],
    }),
    {
      statement: "Atlas uses SQLite.",
      nodeName: "Atlas storage",
      writeSource: "user",
    },
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
        ["session-id", ["session-42"]],
        ["evidence", ["The schema reports SQLite."]],
        ["source-ref", ["tool:sqlite-schema"]],
        ["collection-origin", ["controlled"]],
      ]),
      positionals: ["memory-42"],
    }),
    {
      semanticTaskId: "task:42",
      activeGraphId: "ag-42",
      sessionId: "session-42",
      collectionOrigin: "controlled",
      votes: [
        {
          memoryId: "memory-42",
          claimIndexes: [0, 2],
          outcome: "supported",
          source: "tool",
          sourceLineage: "tool-run:42",
          evidenceSource: {
            actor: "tool",
            content: "The schema reports SQLite.",
            sessionId: "session-42",
            sourceMessageId: "tool-run:42",
            sourceRef: "tool:sqlite-schema",
          },
          weight: 0.8,
        },
      ],
    },
  );
});

test("CLI exposes topology proposal administration without raw database access", () => {
  const byName = (name: string) => NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === name)!;
  assert.deepEqual(
    byName("topology proposals").buildParams({
      flags: new Set(),
      options: new Map([["status", ["accepted"]]]),
      positionals: [],
    }),
    { action: "list", status: "accepted" },
  );
  assert.deepEqual(
    byName("topology assess").buildParams({
      flags: new Set(),
      options: new Map([
        ["minimum-observations", ["4"]],
        ["minimum-estimated-gain", ["0.25"]],
        ["minimum-evidence-memories", ["3"]],
      ]),
      positionals: ["proposal-1"],
    }),
    {
      action: "assess",
      proposalId: "proposal-1",
      minimumObservations: 4,
      minimumEstimatedGain: 0.25,
      minimumEvidenceMemories: 3,
    },
  );
  assert.deepEqual(
    byName("topology review").buildParams({
      flags: new Set(),
      options: new Map([["decision", ["accept"]]]),
      positionals: ["proposal-1"],
    }),
    { action: "review", proposalId: "proposal-1", decision: "accept" },
  );
  assert.deepEqual(
    byName("topology actuate").buildParams({
      flags: new Set(),
      options: new Map(),
      positionals: ["proposal-1"],
    }),
    { action: "actuate", proposalId: "proposal-1" },
  );
});

test("CLI board put exposes directed delivery", () => {
  const command = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "board put")!;
  assert.deepEqual(
    command.buildParams({
      flags: new Set(),
      options: new Map([
        ["agent", ["sender"]],
        ["to", ["kimi"]],
      ]),
      positionals: ["default", "review", "this"],
    }),
    {
      action: "put",
      taskId: "default",
      content: "review this",
      agentId: "sender",
      to: "kimi",
    },
  );
});

test("CLI board discover exposes the system-layer agent roster", () => {
  const command = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "board discover")!;
  assert.deepEqual(
    command.buildParams({
      flags: new Set(),
      options: new Map([
        ["agent", ["dispatcher"]],
        ["capabilities", ["audit"]],
      ]),
      positionals: [],
    }),
    {
      action: "discover",
      taskId: "default",
      agentId: "dispatcher",
      capabilities: "audit",
    },
  );
});
