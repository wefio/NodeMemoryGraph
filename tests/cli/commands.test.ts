import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_KNOWN_FLAGS,
  CLI_KNOWN_OPTIONS,
  cliCommandUsage,
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

test("CLI search exposes bounded chain disclosure without leaking storage details", () => {
  const search = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "search")!;
  assert.deepEqual(
    search.buildParams({
      flags: new Set(["no-chain-expansion"]),
      options: new Map([
        ["chain-max-chains", ["3"]],
        ["chain-hops", ["1"]],
        ["chain-memory-hops", ["2"]],
      ]),
      positionals: ["project", "history"],
    }),
    {
      query: "project history",
      expandChains: false,
      chainExpansionMaxChains: 3,
      chainExpansionMaxHops: 1,
      chainExpansionMaxMemoryHops: 2,
    },
  );
});

test("CLI exposes complete memory-chain member and edge operations", () => {
  const byName = (name: string) => NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === name)!;
  const scoped = new Map([
    ["chain", ["chain-1"]],
    ["project-dir", ["C:/atlas"]],
    ["session-id", ["session-a"]],
  ]);
  assert.deepEqual(
    byName("chain remove").buildParams({
      flags: new Set(),
      options: new Map([...scoped, ["memory", ["memory-1"]]]),
      positionals: [],
    }),
    {
      chainId: "chain-1",
      memoryId: "memory-1",
      projectDir: "C:/atlas",
      sessionId: "session-a",
    },
  );
  assert.deepEqual(
    byName("chain edge add").buildParams({
      flags: new Set(),
      options: new Map([...scoped, ["from", ["memory-1"]], ["to", ["memory-2"]]]),
      positionals: [],
    }),
    {
      chainId: "chain-1",
      sourceMemoryId: "memory-1",
      targetMemoryId: "memory-2",
      edgeType: "order",
      projectDir: "C:/atlas",
      sessionId: "session-a",
    },
  );
  assert.deepEqual(
    byName("chain edge remove").buildParams({
      flags: new Set(),
      options: new Map([...scoped, ["from", ["memory-1"]], ["to", ["memory-2"]]]),
      positionals: [],
    }),
    {
      chainId: "chain-1",
      sourceMemoryId: "memory-1",
      targetMemoryId: "memory-2",
      projectDir: "C:/atlas",
      sessionId: "session-a",
    },
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

test("CLI exposes review-only memory maintenance proposals", () => {
  const byName = (name: string) => NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === name)!;
  assert.deepEqual(
    byName("maintenance propose").buildParams({
      flags: new Set(),
      options: new Map([
        ["defect", ["scope"]],
        ["maintenance-action", ["rescope"]],
        ["target-memory", ["memory-1", "memory-2"]],
        ["evidence-memory", ["memory-3"]],
        ["scope", ["project=atlas"]],
        ["policy-id", ["policy"]],
        ["policy-revision", ["1"]],
        ["policy-hash", ["sha256:policy"]],
        ["policy-min-score", ["0.7"]],
        ["score", ["0.82"]],
        ["evaluation-kind", ["held_out"]],
        ["evaluation-ref", ["eval:1"]],
      ]),
      positionals: [],
    }),
    {
      action: "propose",
      defectType: "scope",
      maintenanceAction: "rescope",
      targetMemoryIds: ["memory-1", "memory-2"],
      evidenceMemoryIds: ["memory-3"],
      evidenceTraceIds: undefined,
      proposedStatement: undefined,
      proposedScope: { project: "atlas" },
      policy: {
        id: "policy",
        revision: "1",
        sourceHash: "sha256:policy",
        minimumLongHorizonScore: 0.7,
      },
      longHorizonScore: 0.82,
      evaluationKind: "held_out",
      evaluationRef: "eval:1",
    },
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

test("per-command help renders a focused usage for the command group", () => {
  const focused = cliCommandUsage("search");
  assert.ok(focused, "search must have a command-scoped usage");
  assert.match(focused!, /NMG command line — search/);
  assert.match(focused!, /nmg search QUERY/);
  // The focused page must expand what the global synopsis hides behind
  // "[options]" — agents discover real flag names here, not from source.
  assert.match(focused!, /--max-tier N/);
  assert.match(focused!, /--compact-json/);
  assert.match(focused!, /Common options:/);
});

test("per-command help groups multi-word commands and rejects unknown ones", () => {
  const board = cliCommandUsage("board");
  assert.ok(board);
  for (const sub of ["discover", "put", "read", "resolve", "claim", "release"]) {
    assert.match(board!, new RegExp(`nmg board ${sub}`));
  }
  assert.equal(cliCommandUsage("definitely-not-a-command"), undefined);
});
