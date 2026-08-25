import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { stgStorePath } from "../../src/core/stg.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("status and hello do not create or open the database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-status-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const hello = await service.invoke("hello");
    const status = await service.invoke("status");
    assert.equal(hello.protocol, NMG_PROTOCOL_VERSION);
    assert.ok(hello.capabilities.includes("search"));
    assert.ok(hello.capabilities.includes("lab-capabilities"));
    assert.equal(status.storage.exists, false);
    assert.equal(status.storage.loaded, false);
    assert.equal(existsSync(databasePath), false);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("memory maintenance RPC persists review-only proposals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-maintenance-proposal-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "Atlas currently runs in region eu-west",
      nodeName: "Atlas deployment",
      sourceActor: "user",
    });
    const proposed = await service.invoke("memoryMaintenanceProposal", {
      action: "propose",
      defectType: "retrieval",
      maintenanceAction: "observe",
      targetMemoryIds: [remembered.memory.id],
      policy: {
        id: "policy",
        revision: "1",
        sourceHash: "sha256:policy",
        minimumLongHorizonScore: 0.5,
      },
      longHorizonScore: 0.75,
      evaluationKind: "matched_replay",
      evaluationRef: "replay:atlas",
    });
    assert.equal(proposed.action, "propose");
    if (proposed.action !== "propose") throw new Error("expected proposal result");

    const reviewed = await service.invoke("memoryMaintenanceProposal", {
      action: "review",
      proposalId: proposed.proposal.id,
      decision: "reject",
      reason: "selection policy will be calibrated separately",
    });
    assert.equal(reviewed.action, "review");
    if (reviewed.action !== "review") throw new Error("expected review result");
    assert.equal(reviewed.proposal.status, "rejected");
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("Lab RPC is session scoped and reasoning workspaces are daemon owned", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-lab-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    dataDirectory: directory,
    environment: {},
  });
  try {
    const listed = await service.invoke("lab", { action: "list" });
    assert.equal(listed.action, "list");
    if (listed.action !== "list") throw new Error("expected Lab list result");
    assert.ok(listed.capabilities.some((item) => item.id === "reasoning_workspace"));

    const enabled = await service.invoke("lab", {
      action: "enable",
      capability: "reasoning_workspace",
      scope: "session",
      sessionId: "session-a",
      requester: "agent:test",
      reason: "keep an auditable investigation scratchpad",
    });
    assert.equal(enabled.action, "enable");

    const added = await service.invoke("lab", {
      action: "invoke",
      capability: "reasoning_workspace",
      sessionId: "session-a",
      operation: "add",
      input: { kind: "hypothesis", content: "The parser owns the regression." },
    });
    assert.equal(added.action, "invoke");

    const checkpoint = await service.invoke("lab", {
      action: "invoke",
      capability: "reasoning_workspace",
      sessionId: "session-a",
      operation: "checkpoint",
      input: { maxNodes: 8, maxChars: 2_000 },
    });
    assert.equal(checkpoint.action, "invoke");
    if (checkpoint.action !== "invoke") throw new Error("expected Lab invoke result");
    assert.match(JSON.stringify(checkpoint.output), /parser owns the regression/);

    await assert.rejects(
      service.invoke("lab", {
        action: "invoke",
        capability: "reasoning_workspace",
        sessionId: "session-b",
        operation: "checkpoint",
      }),
      /not enabled for session/,
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("Lab RPC exposes read-only memory graph reasoning after explicit activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-mgr-"));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  try {
    await service.invoke("lab", {
      action: "enable",
      capability: "memory_graph_reasoner",
      sessionId: "session-mgr",
      requester: "agent:test",
      reason: "compare competing memory paths",
    });
    const result = await service.invoke("lab", {
      action: "invoke",
      capability: "memory_graph_reasoner",
      sessionId: "session-mgr",
      operation: "traverse",
      input: {
        queryVector: [1, 0],
        graph: [
          { id: "relevant", vector: [1, 0] },
          { id: "noise", vector: [0, 1] },
        ],
        maxSteps: 1,
      },
    });
    assert.equal(result.action, "invoke");
    if (result.action !== "invoke") throw new Error("expected Lab invoke result");
    assert.equal(
      (result.output as { path: Array<{ nodeId: string }> }).path[0]?.nodeId,
      "relevant",
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("task board RPC shares temporary coordination without creating semantic memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-board-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const written = await service.invoke("taskBoard", {
      action: "put",
      taskId: "shared-task",
      agentId: "agent-a",
      sourceSessionId: "session-a",
      kind: "handoff",
      content: "Agent B should inspect the parser.",
      ttlSeconds: 3600,
    });
    assert.equal(written.action, "put");

    const read = await service.invoke("taskBoard", {
      action: "read",
      taskId: "shared-task",
      agentId: "agent-b",
    });
    assert.equal(read.action, "read");
    if (read.action !== "read") throw new Error("expected task board read result");
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0]!.agentId, "agent-a");

    const resolved = await service.invoke("taskBoard", {
      action: "resolve",
      taskId: "shared-task",
      agentId: "agent-b",
      entryId: read.entries[0]!.id,
      resolution: "Parser review complete.",
    });
    assert.equal(resolved.action, "resolve");
    if (resolved.action === "read") throw new Error("expected task board resolve result");
    assert.equal(resolved.entry.resolvedBy, "agent-b");

    const store = new NmgStore(databasePath);
    try {
      assert.deepEqual(store.search("parser"), []);
    } finally {
      store.close();
    }
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("task board acknowledge records a no-reply confirmation visible on read and to deliveryCheck", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-ack-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const written = await service.invoke("taskBoard", {
      action: "put",
      taskId: "acks",
      agentId: "sender",
      sourceSessionId: "session-sender",
      kind: "result",
      content: "QPP feeds tau calibration, not the SkillOpt gate.",
      ttlSeconds: 3600,
    });
    if (written.action !== "put") throw new Error("expected put");

    // Ack from two collaborators.
    for (const agentId of ["agent-a", "agent-b"]) {
      const acked = await service.invoke("taskBoard", {
        action: "acknowledge",
        taskId: "acks",
        agentId,
        entryId: written.entry.id,
        reason: "agreed",
      });
      assert.equal(acked.action, "acknowledge");
      if (acked.action !== "acknowledge") throw new Error("expected acknowledge");
      assert.deepEqual(
        acked.entry.ackedBy,
        ["agent-a", "agent-b"].slice(0, agentId === "agent-a" ? 1 : 2),
      );
    }

    // Read surfaces the N checkmarks.
    const read = await service.invoke("taskBoard", {
      action: "read",
      taskId: "acks",
      agentId: "agent-c",
    });
    if (read.action !== "read") throw new Error("expected read");
    assert.deepEqual(read.entries[0]!.ackedBy, ["agent-a", "agent-b"]);

    // deliveryCheck reports acked entries for the acking agents.
    const check = (await service.invoke("taskBoard", {
      action: "deliveryCheck",
      taskId: "acks",
      agentId: "agent-a",
      sessionId: "agent-a",
      entryIds: [written.entry.id],
    })) as { action: "deliveryCheck"; acked: string[] };
    assert.deepEqual(check.acked, [written.entry.id]);
    const checkUnacked = (await service.invoke("taskBoard", {
      action: "deliveryCheck",
      taskId: "acks",
      agentId: "agent-c",
      sessionId: "agent-c",
      entryIds: [written.entry.id],
    })) as { action: "deliveryCheck"; acked: string[] };
    assert.deepEqual(checkUnacked.acked, []);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service rolls back a journaled node merge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-node-rollback-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const first = await service.invoke("remember", {
      statement: "Atlas uses cobalt labels.",
      nodeName: "Atlas labels",
    });
    const second = await service.invoke("remember", {
      statement: "Atlas release notes stay concise.",
      nodeName: "Atlas release notes",
    });
    const transform = await service.invoke("mergeNodes", {
      sourceNodeIds: [first.node.id, second.node.id],
      targetName: "Atlas conventions",
    });

    const rolledBack = await service.invoke("rollbackNodeTransform", {
      transformId: transform.id,
    });
    assert.ok(rolledBack.rolledBackAt);

    const reader = new NmgStore(databasePath);
    try {
      assert.equal(reader.getContext([first.memory.id]).results[0]!.node.id, first.node.id);
      assert.equal(reader.getContext([second.memory.id]).results[0]!.node.id, second.node.id);
    } finally {
      reader.close();
    }
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service remembers, searches, and expands exact evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-roundtrip-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "The Atlas project must remain offline-first.",
      nodeName: "Atlas architecture",
      memoryType: "constraint",
      evidence: "The Atlas project must remain offline-first.",
      scope: { project: "atlas" },
    });
    const searched = await service.invoke("search", {
      query: "Atlas offline first",
      scope: { project: "atlas" },
    });
    assert.equal(searched.results[0]?.memory.id, remembered.memory.id);

    const expanded = await service.invoke("get", {
      memoryIds: [remembered.memory.id, "missing-memory"],
    });
    assert.equal(expanded.results[0]?.evidence.content, remembered.history.content);
    assert.deepEqual(expanded.missingMemoryIds, ["missing-memory"]);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("remember resolution lets an external semantic judge apply a validated supersession", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-resolve-remember-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const oldValue = await service.invoke("remember", {
      statement: "The Atlas database is PostgreSQL.",
      nodeName: "Atlas database",
      scope: { project: "atlas" },
    });
    const newValue = await service.invoke("remember", {
      statement: "The Atlas database is now SQLite.",
      nodeName: "Atlas database",
      scope: { project: "atlas" },
    });
    const resolved = await service.invoke("resolveRemember", {
      action: "supersede",
      newMemoryId: newValue.memory.id,
      supersededMemoryId: oldValue.memory.id,
      reason: "The user explicitly changed the database choice.",
    });
    if (resolved.action !== "supersede") {
      throw new Error(`expected supersede, got ${resolved.action}`);
    }
    assert.equal(resolved.applied, true);
    const search = await service.invoke("search", {
      query: "Atlas database",
      scope: { project: "atlas" },
      includeHistorical: true,
    });
    const stale = search.results.find((entry) => entry.memory.id === oldValue.memory.id);
    assert.equal(stale?.memory.status, "superseded");
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("remember relation resolution creates a reversible proposal without merging nodes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-relate-remember-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const specific = await service.invoke("remember", {
      statement: "Atlas stores its local index in SQLite.",
      nodeName: "Atlas local index",
    });
    const general = await service.invoke("remember", {
      statement: "Atlas has an offline storage subsystem.",
      nodeName: "Atlas storage",
    });
    const resolved = await service.invoke("resolveRemember", {
      action: "relate",
      newMemoryId: specific.memory.id,
      relatedMemoryId: general.memory.id,
      relationJudgement: "refines",
      confidence: 0.84,
    });
    assert.equal(resolved.action, "relate");
    assert.equal(resolved.proposal.status, "pending");
    assert.equal(resolved.proposal.relationType, "refines");
    assert.deepEqual(resolved.proposal.evidenceMemoryIds, [specific.memory.id, general.memory.id]);

    const listed = await service.invoke("topologyProposal", { action: "list" });
    assert.deepEqual(
      listed.proposals.map((proposal) => proposal.id),
      [resolved.proposal.id],
    );
    const assessment = await service.invoke("topologyProposal", {
      action: "assess",
      proposalId: resolved.proposal.id,
    });
    assert.equal(assessment.assessment.proposalId, resolved.proposal.id);
    assert.equal(assessment.assessment.eligible, false);
    const reviewed = await service.invoke("topologyProposal", {
      action: "review",
      proposalId: resolved.proposal.id,
      decision: "accept",
    });
    assert.equal(reviewed.proposal.status, "accepted");
    await assert.rejects(
      service.invoke("topologyProposal", {
        action: "actuate",
        proposalId: resolved.proposal.id,
      }),
      /automatic merge/i,
    );

    const search = await service.invoke("search", { query: "Atlas storage", limit: 10 });
    assert.deepEqual(
      new Set(search.results.map((entry) => entry.memory.id)),
      new Set([specific.memory.id, general.memory.id]),
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("remember relation resolution rejects identity claims across conflicting scopes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-relate-scope-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const atlas = await service.invoke("remember", {
      statement: "Sam maintains Atlas.",
      nodeName: "Sam in Atlas",
      scope: { project: "atlas" },
    });
    const beacon = await service.invoke("remember", {
      statement: "Sam maintains Beacon.",
      nodeName: "Sam in Beacon",
      scope: { project: "beacon" },
    });
    await assert.rejects(
      service.invoke("resolveRemember", {
        action: "relate",
        newMemoryId: atlas.memory.id,
        relatedMemoryId: beacon.memory.id,
        relationJudgement: "same_entity",
      }),
      /requires non-conflicting scope/,
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("remember conflict resolution accepts scope intersections but rejects adjacent validity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-relate-domain-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const broad = await service.invoke("remember", {
      statement: "The service uses SQLite.",
      nodeName: "Service database",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-03-01T00:00:00.000Z",
    });
    const scoped = await service.invoke("remember", {
      statement: "Atlas does not use SQLite.",
      nodeName: "Atlas database",
      scope: { project: "atlas" },
      validFrom: "2026-02-01T00:00:00.000Z",
      validUntil: "2026-03-01T00:00:00.000Z",
    });
    const accepted = await service.invoke("resolveRemember", {
      action: "relate",
      newMemoryId: scoped.memory.id,
      relatedMemoryId: broad.memory.id,
      relationJudgement: "conflict",
    });
    assert.equal(accepted.action, "relate");
    assert.equal(accepted.proposal.relationType, "contradicts");

    const later = await service.invoke("remember", {
      statement: "Atlas uses Postgres from March.",
      nodeName: "Atlas database later",
      scope: { project: "atlas" },
      validFrom: "2026-03-01T00:00:00.000Z",
    });
    await assert.rejects(
      service.invoke("resolveRemember", {
        action: "relate",
        newMemoryId: later.memory.id,
        relatedMemoryId: broad.memory.id,
        relationJudgement: "conflict",
      }),
      /requires overlapping validity/u,
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("remember forget resolution withdraws a selected memory from retrieval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-forget-remember-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "The user uses the alias Sparrow.",
      nodeName: "User aliases",
    });
    const resolved = await service.invoke("resolveRemember", {
      action: "forget",
      memoryId: remembered.memory.id,
    });
    assert.deepEqual(resolved, {
      action: "forget",
      memoryId: remembered.memory.id,
      deleted: true,
    });
    const search = await service.invoke("search", {
      query: "alias Sparrow",
      includeHistorical: true,
    });
    assert.equal(
      search.results.some((entry) => entry.memory.id === remembered.memory.id),
      false,
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("remember open, resolve, and reopen lifecycle survives service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-open-memory-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  let openMemoryId = "";
  let anchorMemoryId = "";
  try {
    const anchor = await service.invoke("remember", {
      statement: "Atlas storage choice blocks deployment.",
      nodeName: "Atlas deployment blocker",
    });
    anchorMemoryId = anchor.memory.id;
    const open = await service.invoke("remember", {
      statement: "Choose the Atlas storage engine.",
      nodeName: "Atlas storage decision",
      resolution: "open",
      relatedMemoryIds: [anchor.memory.id],
    });
    openMemoryId = open.memory.id;
    assert.equal(open.memory.resolution, "open");

    const resolved = await service.invoke("resolveRemember", {
      action: "resolve",
      memoryId: open.memory.id,
      reason: "SQLite was selected.",
    });
    assert.equal(resolved.action, "resolve");
    assert.equal(resolved.resolution, "resolved");

    const reopened = await service.invoke("resolveRemember", {
      action: "reopen",
      memoryId: open.memory.id,
      relatedMemoryIds: [anchor.memory.id],
      reason: "A portability requirement changed.",
    });
    assert.equal(reopened.action, "reopen");
    assert.equal(reopened.resolution, "reopened");
    assert.deepEqual(reopened.relatedMemoryIds, [anchor.memory.id]);
  } finally {
    service.close();
  }

  const reopenedService = new NmgService({ databasePath, environment: {} });
  try {
    const context = await reopenedService.invoke("get", { memoryIds: [openMemoryId] });
    assert.equal(context.results[0]?.memory.resolution, "reopened");
    assert.deepEqual(context.results[0]?.memory.relatedMemoryIds, [anchorMemoryId]);
  } finally {
    reopenedService.close();
    removeTempDirectory(directory);
  }
});

test("memory export defaults can preserve user-owned memory with provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-export-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const userMemory = await service.invoke("remember", {
      statement: "The user prefers concise release notes.",
      nodeName: "Communication preferences",
      sourceActor: "user",
      evidence: "I prefer concise release notes.",
      sourceRef: "pi-session:example",
    });
    await service.invoke("remember", {
      statement: "The assistant suggested adding diagrams.",
      nodeName: "Assistant suggestions",
      sourceActor: "assistant",
      evidence: "I suggest adding diagrams.",
    });

    const exported = await service.invoke("exportMemories", { sourceActor: "user" });
    assert.equal(exported.format, "nmg.memory-export.v1");
    assert.equal(exported.items.length, 1);
    assert.equal(exported.items[0]?.memory.id, userMemory.memory.id);
    assert.equal(exported.items[0]?.node.canonicalName, "Communication preferences");
    assert.equal(exported.items[0]?.evidence[0]?.content, "I prefer concise release notes.");
    assert.equal(exported.items[0]?.evidence[0]?.sourceRef, "pi-session:example");
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service records claim outcomes without changing extraction confidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-claim-outcome-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "Atlas uses SQLite.",
      nodeName: "Atlas database",
    });
    assert.equal(remembered.memory.writeSource, "agent");
    const result = await service.invoke("recordClaimOutcomes", {
      semanticTaskId: "atlas-verification-1",
      collectionOrigin: "controlled",
      votes: [
        {
          memoryId: remembered.memory.id,
          outcome: "supported",
          source: "tool",
          sourceLineage: "sqlite-schema-check",
          evidenceSource: {
            actor: "tool",
            content: "The inspected schema declares SQLite.",
            sessionId: "atlas-verification-session",
            sourceMessageId: "sqlite-schema-check",
            sourceRef: "tool:sqlite-schema",
          },
        },
      ],
    });
    assert.equal(result.events.length, 1);
    assert.ok(result.events[0]?.evidenceId);
    assert.equal(result.events[0]?.collectionOrigin, "controlled");
    assert.equal(result.posteriors[0]?.priorConfidence, 0.5);
    assert.equal(result.posteriors[0]?.independentVoteCount, 1);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service isolates project STG while retaining LTG fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-"));
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const local = await service.invoke("remember", {
      statement: "Project A session branch is blue.",
      nodeName: "Session branch",
      residence: "stg",
      sessionId: "session-test",
      projectDir: projectA,
    });
    const durable = await service.invoke("remember", {
      statement: "The user prefers concise explanations.",
      nodeName: "Response preference",
      memoryType: "preference",
    });

    const inA = await service.invoke("search", {
      query: "session branch blue",
      projectDir: projectA,
      sessionId: "session-test",
    });
    assert.ok(inA.results.some((result) => result.memory.id === local.memory.id));
    const inB = await service.invoke("search", {
      query: "session branch blue",
      projectDir: projectB,
      sessionId: "session-test",
    });
    assert.ok(!inB.results.some((result) => result.memory.id === local.memory.id));

    const fallback = await service.invoke("search", {
      query: "concise explanations",
      projectDir: projectA,
    });
    assert.ok(fallback.results.some((result) => result.memory.id === durable.memory.id));
    const expanded = await service.invoke("get", {
      memoryIds: [local.memory.id],
      projectDir: projectA,
      sessionId: "session-test",
    });
    assert.equal(expanded.results[0]?.memory.id, local.memory.id);
    assert.deepEqual(expanded.missingMemoryIds, []);
    assert.ok(existsSync(stgStorePath(projectA, "cli")));
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service keeps mixed STG/LTG evidence in one AG and attributes both parts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-mixed-ag-"));
  const projectDir = join(directory, "project");
  const databasePath = join(directory, "ltg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const local = await service.invoke("remember", {
      statement: "Atlas session branch uses the cobalt deployment lane.",
      nodeName: "Atlas session lane",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const durable = await service.invoke("remember", {
      statement: "Atlas deployments require concise release notes.",
      nodeName: "Atlas release constraint",
      memoryType: "constraint",
      sessionId: "session-alpha",
    });

    const searched = await service.invoke("search", {
      query: "Which cobalt deployment lane and concise release-note constraint apply to Atlas?",
      projectDir,
      sessionId: "session-alpha",
      secondPass: true,
    });
    assert.ok(searched.results.some((result) => result.memory.id === local.memory.id));
    assert.ok(searched.results.some((result) => result.memory.id === durable.memory.id));
    assert.deepEqual(
      new Set(searched.activeGraph?.memoryIds),
      new Set(searched.results.map((result) => result.memory.id)),
    );

    await service.invoke("get", {
      memoryIds: [local.memory.id, durable.memory.id],
      activeGraphId: searched.activeGraph!.id,
      projectDir,
      sessionId: "session-alpha",
    });

    const ltg = new NmgStore(databasePath);
    const stg = new NmgStore(stgStorePath(projectDir, "session-alpha"));
    try {
      assert.ok(ltg.getContext([durable.memory.id]).results[0]!.memory.accessCount > 0);
      assert.ok(
        stg.getContext([local.memory.id], 0, "session-alpha").results[0]!.memory.accessCount > 0,
      );
    } finally {
      ltg.close();
      stg.close();
    }
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service isolates STG by session inside one project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-session-stg-"));
  const projectDir = join(directory, "project");
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const local = await service.invoke("remember", {
      statement: "Session alpha scratch fact is cobalt.",
      nodeName: "Session scratch",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const alpha = await service.invoke("search", {
      query: "scratch fact cobalt",
      projectDir,
      sessionId: "session-alpha",
    });
    const beta = await service.invoke("search", {
      query: "scratch fact cobalt",
      projectDir,
      sessionId: "session-beta",
    });
    assert.ok(alpha.results.some((result) => result.memory.id === local.memory.id));
    assert.ok(!beta.results.some((result) => result.memory.id === local.memory.id));
    // v2: one shared stg.sqlite per project — session isolation is row-level
    // (session_id filter), not per-session files.
    assert.equal(
      stgStorePath(projectDir, "session-alpha"),
      stgStorePath(projectDir, "session-beta"),
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service exposes complete LTG memory-chain DAG operations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-chain-ltg-"));
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const first = await service.invoke("remember", {
      statement: "Atlas migration starts with an inventory.",
      nodeName: "Atlas migration inventory",
    });
    const second = await service.invoke("remember", {
      statement: "Atlas migration validates the converted database.",
      nodeName: "Atlas migration validation",
    });
    const chain = await service.invoke("chainCreate", {
      chainType: "logical",
      topic: "Atlas migration",
    });
    await service.invoke("chainEdgeAdd", {
      chainId: chain.id,
      sourceMemoryId: first.memory.id,
      targetMemoryId: second.memory.id,
    });
    const loaded = await service.invoke("chainGet", { chainId: chain.id });
    assert.deepEqual(loaded?.topologicalOrder, [first.memory.id, second.memory.id]);
    assert.equal(loaded?.members.length, 2, "edge endpoints auto-join the chain");
    assert.equal(loaded?.edges.length, 1);

    assert.deepEqual(
      await service.invoke("chainEdgeRemove", {
        chainId: chain.id,
        sourceMemoryId: first.memory.id,
        targetMemoryId: second.memory.id,
      }),
      { removed: true },
    );
    await service.invoke("chainEdgeAdd", {
      chainId: chain.id,
      sourceMemoryId: first.memory.id,
      targetMemoryId: second.memory.id,
    });
    assert.deepEqual(
      await service.invoke("chainRemove", {
        chainId: chain.id,
        memoryId: first.memory.id,
      }),
      { removed: true },
    );
    const reduced = await service.invoke("chainGet", { chainId: chain.id });
    assert.deepEqual(reduced?.topologicalOrder, [second.memory.id]);
    assert.equal(reduced?.edges.length, 0, "member removal also removes incident chain edges");
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service keeps STG memory chains inside their owning session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-chain-stg-"));
  const projectDir = join(directory, "project");
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const first = await service.invoke("remember", {
      statement: "Session alpha first scratch decision.",
      nodeName: "Session alpha decision one",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const second = await service.invoke("remember", {
      statement: "Session alpha second scratch decision.",
      nodeName: "Session alpha decision two",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const chain = await service.invoke("chainCreate", {
      chainType: "temporal",
      topic: "Session alpha scratch sequence",
      projectDir,
      sessionId: "session-alpha",
    });
    assert.equal(chain.ownerSessionId, "session-alpha");
    await service.invoke("chainAdd", {
      chainId: chain.id,
      memoryId: first.memory.id,
      projectDir,
      sessionId: "session-alpha",
    });
    await service.invoke("chainAdd", {
      chainId: chain.id,
      memoryId: second.memory.id,
      projectDir,
      sessionId: "session-alpha",
    });
    const alpha = await service.invoke("chainGet", {
      chainId: chain.id,
      projectDir,
      sessionId: "session-alpha",
    });
    assert.equal(alpha?.members.length, 2);
    assert.equal(
      (
        await service.invoke("chainList", {
          projectDir,
          sessionId: "session-alpha",
        })
      ).length,
      1,
    );
    assert.equal((await service.invoke("chainList", {})).length, 0, "chain was not written to LTG");
    assert.equal(
      (
        await service.invoke("chainList", {
          projectDir,
          sessionId: "session-beta",
        })
      ).length,
      0,
    );
    await assert.rejects(
      service.invoke("chainGet", {
        chainId: chain.id,
        projectDir,
        sessionId: "session-beta",
      }),
      /belongs to another session/u,
    );
    await assert.rejects(
      service.invoke("chainCreate", {
        chainType: "logical",
        topic: "forged owner",
        ownerSessionId: "session-beta",
        projectDir,
        sessionId: "session-alpha",
      }),
      /owner must match/u,
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service records nmg_get disclosure only for the owning session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-owned-ag-"));
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "Atlas uses a session-owned memory trace.",
      nodeName: "Atlas trace",
    });
    const searched = await service.invoke("search", {
      query: "Atlas session owned trace",
      sessionId: "session-alpha",
    });
    const activeGraphId = searched.activeGraph!.id;
    await assert.rejects(
      service.invoke("get", {
        memoryIds: [remembered.memory.id],
        activeGraphId,
        sessionId: "session-beta",
      }),
      /belongs to another session/,
    );
    await service.invoke("get", {
      memoryIds: [remembered.memory.id],
      activeGraphId,
      sessionId: "session-alpha",
    });
    const reader = new NmgStore(join(directory, "ltg.sqlite"));
    try {
      const trace = reader.retrievalTrace(activeGraphId, "session-alpha");
      assert.deepEqual(trace?.disclosedMemoryIds, [remembered.memory.id]);
      assert.deepEqual(trace?.usefulMemoryIds, [], "disclosure is not answer attribution");
    } finally {
      reader.close();
    }
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service syncs a scoped LTG working set into project STG idempotently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-sync-"));
  const projectDir = join(directory, "project");
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    await service.invoke("remember", {
      statement: "Project atlas uses SQLite.",
      nodeName: "Atlas storage",
      scope: { project: "atlas" },
    });
    const first = await service.invoke("syncStg", {
      projectDir,
      scope: { project: "atlas" },
      limit: 10,
    });
    const second = await service.invoke("syncStg", {
      projectDir,
      scope: { project: "atlas" },
      limit: 10,
    });
    assert.equal(first.copied, 1);
    assert.equal(second.copied, 0);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service can automatically cache a scoped LTG working set on project search", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-auto-sync-"));
  const projectDir = join(directory, "project");
  const service = new NmgService({
    databasePath: join(directory, "ltg.sqlite"),
    environment: {
      NMG_STG_AUTO_SYNC: "1",
      NMG_STG_AUTO_SYNC_LIMIT: "10",
      NMG_STG_AUTO_SYNC_INTERVAL_SECONDS: "60",
    },
  });
  try {
    const remembered = await service.invoke("remember", {
      statement: "Project atlas uses SQLite for durable state.",
      nodeName: "Atlas storage",
      scope: { project: "atlas" },
    });
    await service.invoke("search", {
      query: "atlas durable state",
      projectDir,
      sessionId: "session-alpha",
      scope: { project: "atlas" },
    });

    const stg = new NmgStore(stgStorePath(projectDir));
    try {
      const cached = stg.search("atlas durable state", {
        scope: { project: "atlas" },
        maxTier: 3,
        limit: 10,
      });
      assert.ok(
        cached.some((entry) =>
          entry.memory.markers.some(
            (marker) =>
              marker.kind === "cached_from_ltg" &&
              marker.attributes?.sourceMemoryId === remembered.memory.id,
          ),
        ),
      );
    } finally {
      stg.close();
    }
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("STG consolidation stays shadow by default and can be enabled after strong outcomes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-consolidation-"));
  const projectDir = join(directory, "project");
  const databasePath = join(directory, "ltg.sqlite");
  const environment = {
    NMG_STG_CONSOLIDATE_MIN_VOTES: "1",
    NMG_STG_CONSOLIDATE_MIN_MEAN: "0",
    NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND: "0",
  };
  const service = new NmgService({ databasePath, environment });
  try {
    const local = await service.invoke("remember", {
      statement: "Atlas durable convention uses cobalt labels.",
      nodeName: "Atlas convention",
      evidence: "The user confirmed the cobalt label convention.",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const shadow = await service.invoke("recordClaimOutcomes", {
      projectDir,
      sessionId: "session-alpha",
      semanticTaskId: "task-one",
      votes: [
        {
          memoryId: local.memory.id,
          outcome: "supported",
          source: "user",
          sourceLineage: "message:user-confirmation-1",
        },
      ],
    });
    assert.deepEqual(shadow.consolidationCandidates, [local.memory.id]);
    assert.deepEqual(shadow.consolidatedMemories, []);
  } finally {
    service.close();
  }

  const active = new NmgService({
    databasePath,
    environment: { ...environment, NMG_STG_AUTO_CONSOLIDATE: "1" },
  });
  try {
    const localStore = new NmgStore(stgStorePath(projectDir, "session-alpha"));
    const [memory] = localStore.exportMemories({ sourceActor: "user" }).items;
    localStore.close();
    assert.ok(memory);
    const promoted = await active.invoke("recordClaimOutcomes", {
      projectDir,
      sessionId: "session-alpha",
      semanticTaskId: "task-two",
      votes: [
        {
          memoryId: memory!.memory.id,
          outcome: "supported",
          source: "user",
          sourceLineage: "message:user-confirmation-2",
        },
      ],
    });
    assert.equal(promoted.consolidatedMemories.length, 1);
    const ltg = new NmgStore(databasePath);
    try {
      assert.equal(ltg.search("cobalt labels", { maxTier: 3 }).length, 1);
    } finally {
      ltg.close();
    }
  } finally {
    active.close();
    removeTempDirectory(directory);
  }
});

test("automatic STG consolidation retracts only its own LTG copy when posterior support falls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-retract-"));
  const projectDir = join(directory, "project");
  const databasePath = join(directory, "ltg.sqlite");
  const service = new NmgService({
    databasePath,
    environment: {
      NMG_STG_AUTO_CONSOLIDATE: "1",
      NMG_STG_CONSOLIDATE_MIN_VOTES: "1",
      NMG_STG_CONSOLIDATE_MIN_MEAN: "0.55",
      NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND: "0",
    },
  });
  try {
    const local = await service.invoke("remember", {
      statement: "Atlas build labels are cobalt.",
      nodeName: "Atlas build labels",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const promoted = await service.invoke("recordClaimOutcomes", {
      projectDir,
      sessionId: "session-alpha",
      semanticTaskId: "confirmation-one",
      votes: [
        {
          memoryId: local.memory.id,
          outcome: "supported",
          source: "user",
          sourceLineage: "message:confirmation-one",
        },
      ],
    });
    assert.equal(promoted.consolidatedMemories.length, 1);
    assert.deepEqual(promoted.retractedMemories, []);

    const corrected = await service.invoke("recordClaimOutcomes", {
      projectDir,
      sessionId: "session-alpha",
      semanticTaskId: "correction-two",
      votes: [
        {
          memoryId: local.memory.id,
          outcome: "contradicted",
          source: "user",
          sourceLineage: "message:correction-two",
        },
      ],
    });
    assert.equal(corrected.retractedMemories.length, 1);
    assert.equal(
      (await service.invoke("search", { query: "cobalt build labels" })).results.length,
      0,
      "the automatically materialized LTG copy is withdrawn",
    );

    const requalified = await service.invoke("recordClaimOutcomes", {
      projectDir,
      sessionId: "session-alpha",
      semanticTaskId: "confirmation-three",
      votes: [
        {
          memoryId: local.memory.id,
          outcome: "supported",
          source: "user",
          sourceLineage: "message:confirmation-three",
        },
      ],
    });
    assert.equal(requalified.consolidatedMemories.length, 1);
    assert.notEqual(
      requalified.consolidatedMemories[0]!.memoryId,
      promoted.consolidatedMemories[0]!.memoryId,
      "requalification creates a fresh auditable LTG version",
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("STG correction never retracts a pre-existing manual LTG duplicate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-manual-"));
  const projectDir = join(directory, "project");
  const databasePath = join(directory, "ltg.sqlite");
  const service = new NmgService({
    databasePath,
    environment: {
      NMG_STG_AUTO_CONSOLIDATE: "1",
      NMG_STG_CONSOLIDATE_MIN_VOTES: "1",
      NMG_STG_CONSOLIDATE_MIN_MEAN: "0.55",
      NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND: "0",
    },
  });
  try {
    const manual = await service.invoke("remember", {
      statement: "Atlas release channel is stable.",
      nodeName: "Atlas release channel",
    });
    const local = await service.invoke("remember", {
      statement: "Atlas release channel is stable.",
      nodeName: "Atlas release channel",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const first = await service.invoke("recordClaimOutcomes", {
      projectDir,
      sessionId: "session-alpha",
      semanticTaskId: "confirmation-one",
      votes: [
        {
          memoryId: local.memory.id,
          outcome: "supported",
          source: "user",
          sourceLineage: "message:confirmation-one",
        },
      ],
    });
    assert.deepEqual(
      first.consolidatedMemories,
      [],
      "manual duplicate is not claimed as automatic",
    );

    const corrected = await service.invoke("recordClaimOutcomes", {
      projectDir,
      sessionId: "session-alpha",
      semanticTaskId: "correction-two",
      votes: [
        {
          memoryId: local.memory.id,
          outcome: "contradicted",
          source: "user",
          sourceLineage: "message:correction-two",
        },
      ],
    });
    assert.deepEqual(corrected.retractedMemories, []);
    assert.equal(
      (await service.invoke("get", { memoryIds: [manual.memory.id] })).results.length,
      1,
      "manual LTG truth remains independently owned",
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("resident service exposes explicit retention and deletion maintenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-maintenance-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "A disposable historical observation.",
      nodeName: "Disposable observations",
      memoryType: "event",
      importance: 0.1,
    });
    const archived = await service.invoke("setStorageState", {
      memoryId: remembered.memory.id,
      storageState: "dormant",
    });
    assert.equal(archived.storageState, "dormant");
    assert.equal(
      (await service.invoke("search", { query: "disposable historical" })).results.length,
      0,
    );

    await service.invoke("setStorageState", {
      memoryId: remembered.memory.id,
      storageState: "indexed",
    });
    assert.equal(
      (await service.invoke("search", { query: "disposable historical" })).results.length,
      1,
    );

    const deleted = await service.invoke("deleteMemory", { memoryId: remembered.memory.id });
    assert.equal(deleted.deleted, true);
    assert.equal(
      (await service.invoke("search", { query: "disposable historical" })).results.length,
      0,
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("remember schedules thresholded maintenance after returning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-auto-maintenance-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: {
      NMG_MAINTENANCE_WRITE_THRESHOLD: "1",
      NMG_MAINTENANCE_ACCESS_THRESHOLD: "1",
      NMG_MAINTENANCE_NODE_LIMIT: "1",
    },
  });
  try {
    const remembered = await service.invoke("remember", {
      statement: "Maintenance is deferred until after remember.",
      nodeName: "Maintenance scheduling",
    });
    assert.ok(remembered.memory.id, "remember completes independently of maintenance");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const aggregates = await service.invoke("perfAggregates");
    assert.ok(aggregates.some((aggregate) => aggregate.section === "maintenance.batch"));
    assert.ok(aggregates.some((aggregate) => aggregate.section === "maintenance.semantic"));
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("service maintenance bounds a write backlog distributed across small nodes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-distributed-maintenance-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({
    databasePath,
    environment: {
      NMG_MAINTENANCE_WRITE_THRESHOLD: "4",
      NMG_MAINTENANCE_ACCESS_THRESHOLD: "32",
      NMG_MAINTENANCE_NODE_LIMIT: "2",
    },
  });
  try {
    for (let index = 0; index < 5; index += 1) {
      await service.invoke("remember", {
        statement: `Distributed service write ${index}`,
        nodeName: `Distributed service node ${index}`,
      });
    }
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
  } finally {
    service.close();
  }

  const reader = new NmgStore(databasePath);
  try {
    assert.ok(
      reader.pendingIndexDelta().length < 4,
      "recursive bounded slices reduce global backlog below its trigger threshold",
    );
  } finally {
    reader.close();
    removeTempDirectory(directory);
  }
});

test("service validates method parameters", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-errors-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    await assert.rejects(service.invoke("get", { memoryIds: [] }), {
      code: "INVALID_PARAMS",
    });
    await assert.rejects(
      service.invoke("remember", {
        statement: "The current version is 2.",
        nodeName: "Current version",
        memoryType: "state",
      }),
      { code: "INVALID_PARAMS" },
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("external source markers persist and default trust to unverified", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-external-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "The project documentation names SQLite as its storage engine.",
      nodeName: "Project storage",
      markers: [
        {
          kind: "external_source",
          attributes: {
            source: "file:README.md",
            retrievedAt: "2026-08-01T00:00:00.000Z",
            hash: "sha256:test",
          },
        },
      ],
    });
    assert.equal(remembered.memory.truthStatus, "unverified");
    assert.equal(remembered.memory.markers[0]?.kind, "external_source");
    assert.equal(remembered.memory.markers[0]?.attributes?.source, "file:README.md");

    await assert.rejects(
      service.invoke("remember", {
        statement: "Malformed marker",
        nodeName: "Malformed",
        markers: [{ kind: "external_source", attributes: { nested: {} } }],
      } as never),
      { code: "INVALID_PARAMS" },
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("CLI writes pass through the governed memory admission policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-write-policy-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    await assert.rejects(
      service.invoke("remember", {
        statement: "The API key is sk-secret-value-that-must-not-be-stored.",
        nodeName: "Credentials",
        memoryType: "fact",
      }),
      { code: "WRITE_REJECTED" },
    );
    // Transient-word false positive is rejected by default...
    await assert.rejects(
      service.invoke("remember", {
        statement: "用户偏好：持久化文档不带临时时间标注。",
        nodeName: "Docs preference",
        memoryType: "preference",
      }),
      { code: "WRITE_REJECTED" },
    );
    // ...but the explicit escape hatch (unsafe) admits it and tags the audit marker.
    const admitted = await service.invoke("remember", {
      statement: "用户偏好：持久化文档不带临时时间标注。",
      nodeName: "Docs preference",
      memoryType: "preference",
      unsafe: true,
    });
    assert.equal(
      admitted.memory.markers.some((marker: { kind: string }) => marker.kind === "write_bypass"),
      true,
    );
    // The unsafe flag must never override secrets or an explicit user refusal.
    await assert.rejects(
      service.invoke("remember", {
        statement: "The API key is sk-secret-value-that-must-not-be-stored.",
        nodeName: "Credentials",
        memoryType: "fact",
        unsafe: true,
      }),
      { code: "WRITE_REJECTED" },
    );
    await assert.rejects(
      service.invoke("remember", {
        statement: "do not retain this conversation detail",
        nodeName: "Refusal",
        memoryType: "fact",
        unsafe: true,
      }),
      { code: "WRITE_REJECTED" },
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("an unbuilt optional embedding index degrades without blocking lexical search", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-degraded-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: { NMG_EMBED_PROVIDER: "openai" },
  });
  try {
    await service.invoke("remember", {
      statement: "User prefers Chinese explanations.",
      nodeName: "Language preference",
      memoryType: "preference",
    });
    const status = await service.invoke("status");
    assert.equal(status.embedding.configured, true);
    assert.equal(status.embedding.provider, "openai");

    const searched = await service.invoke("search", { query: "Chinese explanations" });
    assert.equal(searched.results.length, 1);
    assert.equal(searched.retrieval?.mode, "lexical");
    assert.equal(searched.retrieval?.reason, "embedding_index_not_ready");
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("opt-in embedding auto-sync makes remembered records available to hybrid search", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-embedding-auto-sync-"));
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const inputs = (JSON.parse(body) as { input: string[] }).input;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [1, 0] })) }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: {
      NMG_EMBED_PROVIDER: "openai",
      NMG_EMBED_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      NMG_EMBED_MODEL: "test-embedding",
      NMG_EMBED_AUTO_SYNC: "1",
    },
  });
  try {
    await service.invoke("remember", {
      statement: "Container vectors execute through CUDA.",
      nodeName: "Container acceleration",
      memoryType: "fact",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await service.invoke("status");
      if (status.embedding.health?.lastSucceededAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const searched = await service.invoke("search", {
      query: "Which hardware acceleration backs the vectors?",
      retrievalMode: "hybrid",
    });
    assert.equal(searched.retrieval?.mode, "hybrid");
    assert.equal(searched.retrieval?.degraded, false);
    assert.equal(searched.results[0]?.memory.statement, "Container vectors execute through CUDA.");
    assert.ok((searched.results[0]?.vectorScore ?? 0) > 0);
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    removeTempDirectory(directory);
  }
});

test("search protocol preserves Pi QPP evidence-window overrides", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-qpp-options-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    for (let index = 0; index < 5; index += 1) {
      await service.invoke("remember", {
        statement: `Atlas deployment evidence item ${index}.`,
        nodeName: `Atlas evidence ${index}`,
      });
    }
    const searched = await service.invoke("search", {
      query: "Atlas deployment evidence",
      limit: 5,
      secondPass: true,
      initialEvidenceTarget: 1,
      strongHitTopGap: 1,
      strongHitInitialTarget: 1,
    });
    assert.equal(searched.activeGraph?.qpp?.expansion?.stages[0]?.targetEvidence, 1);
    const planned = await service.invoke("search", {
      query: "Atlas deployment evidence",
      limit: 5,
      secondPass: false,
      persistTrace: false,
      activeGraphBudget: {
        maxEvidence: 5,
        maxTokens: 7_500,
        maxNodes: 12,
      },
    });
    assert.equal(planned.activeGraph?.budget.maxEvidence, 5);
    assert.equal(planned.activeGraph?.budget.maxTokens, 7_500);
    assert.equal(planned.activeGraph?.budget.maxNodes, 12);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("recordActiveGraphAttribution persists API answer overlap as diagnostic attribution only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-qpp-use-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const saved = await service.invoke("remember", {
      statement: "Atlas stores durable metadata in SQLite.",
      nodeName: "Atlas storage",
      memoryType: "fact",
    });
    const searched = (await service.invoke("search", {
      query: "Atlas durable metadata",
      sessionId: "session-a",
    })) as { results: Array<{ memory: { id: string } }>; activeGraph?: { id: string } };
    assert.ok(searched.activeGraph, "search produced an active graph");
    const recorded = await service.invoke("recordActiveGraphAttribution", {
      activeGraphId: searched.activeGraph.id,
      attributedMemoryIds: [saved.memory.id],
      sessionId: "session-a",
    });
    assert.equal(recorded.activeGraphId, searched.activeGraph.id);
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      const trace = store.retrievalTrace(searched.activeGraph!.id, "session-a");
      assert.ok(trace, "trace exists");
      assert.deepEqual(trace.attributedMemoryIds, [saved.memory.id]);
      assert.deepEqual(trace.usefulMemoryIds, []);
    } finally {
      store.close();
    }
    // wrong session cannot write to another session's trace
    await assert.rejects(
      service.invoke("recordActiveGraphAttribution", {
        activeGraphId: searched.activeGraph!.id,
        attributedMemoryIds: [saved.memory.id],
        sessionId: "session-b",
      }),
      /session/i,
    );
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("task board RPC parses directed delivery and agent discovery actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-board-discovery-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const registered = await service.invoke("taskBoard", {
      action: "registerAgent",
      id: "kimi-002",
      agentName: "kimi",
      capabilities: "audit,stg",
      supportedInterfaces: "kimi",
    });
    assert.deepEqual(registered, {
      action: "registerAgent",
      agentName: "kimi",
      id: "kimi-002",
    });

    const discovered = await service.invoke("taskBoard", {
      action: "discover",
      taskId: "default",
      agentId: "requester",
      capabilities: "stg",
    });
    assert.equal(discovered.action, "discover");
    if (discovered.action !== "discover") throw new Error("expected discover");
    assert.deepEqual(
      discovered.agents.map((agent) => agent.agentName),
      ["kimi"],
    );
    assert.deepEqual(
      discovered.agents.map((agent) => agent.id),
      ["kimi-002"],
    );

    const written = await service.invoke("taskBoard", {
      action: "put",
      taskId: "default",
      agentId: "requester",
      kind: "handoff",
      content: "Inspect STG isolation",
      to: "kimi",
    });
    assert.equal(written.action, "put");
    if (written.action !== "put") throw new Error("expected put");
    assert.equal(written.entry.to, "kimi");
    assert.equal(written.entry.serialState, null);

    const named = await service.invoke("taskBoard", {
      action: "put",
      taskId: "private-review",
      agentId: "requester",
      kind: "handoff",
      content: "Review the private controller trace",
      to: "kimi-002",
    });
    assert.equal(named.action, "put");
    if (named.action !== "put") throw new Error("expected put");
    const inbox = await service.invoke("taskBoard", {
      action: "readDirected",
      agentId: "kimi-002",
      agentName: "kimi",
    });
    assert.equal(inbox.action, "readDirected");
    if (inbox.action !== "readDirected") throw new Error("expected readDirected");
    assert.deepEqual(
      inbox.entries.map((entry) => entry.id),
      [written.entry.id, named.entry.id],
    );

    assert.deepEqual(await service.invoke("taskBoard", { action: "heartbeat", id: "kimi-002" }), {
      action: "heartbeat",
      agentName: "",
      id: "kimi-002",
    });
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("recordActiveGraphAttribution validates its RPC boundary and permits empty attribution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-qpp-params-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    await assert.rejects(
      service.invoke("recordActiveGraphAttribution", {
        activeGraphId: "trace",
        attributedMemoryIds: "not-an-array",
      }),
      /attributedMemoryIds must contain between 0 and 10000 non-empty strings/,
    );
    const searched = await service.invoke("search", {
      query: "no matching memory is expected",
      sessionId: "session-empty-use",
    });
    assert.ok(searched.activeGraph);
    const recorded = await service.invoke("recordActiveGraphAttribution", {
      activeGraphId: searched.activeGraph.id,
      attributedMemoryIds: [],
      sessionId: "session-empty-use",
    });
    assert.deepEqual(recorded.attributedMemoryIds, []);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("task board subscriptions gate broadcast wake while directed delivery uses an inbox", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-subs-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    // Not a member yet: listSubscriptions is empty.
    const none = await service.invoke("taskBoard", {
      action: "listSubscriptions",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    assert.equal(none.action, "listSubscriptions");
    if (none.action !== "listSubscriptions") throw new Error("expected listSubscriptions");
    assert.deepEqual(none.subscriptions, []);

    // Subscribe joins the channel; membership is per-session.
    await service.invoke("taskBoard", {
      action: "subscribe",
      taskId: "review-x",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    const joined = await service.invoke("taskBoard", {
      action: "listSubscriptions",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    if (joined.action !== "listSubscriptions") throw new Error("expected listSubscriptions");
    assert.deepEqual(
      joined.subscriptions.map((item) => item.taskId),
      ["review-x"],
    );

    // session-b never joined review-x.
    const other = await service.invoke("taskBoard", {
      action: "listSubscriptions",
      agentId: "agent-b",
      sessionId: "session-b",
    });
    if (other.action !== "listSubscriptions") throw new Error("expected listSubscriptions");
    assert.deepEqual(other.subscriptions, []);

    // Unsubscribe leaves the channel.
    await service.invoke("taskBoard", {
      action: "unsubscribe",
      taskId: "review-x",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    const left = await service.invoke("taskBoard", {
      action: "listSubscriptions",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    if (left.action !== "listSubscriptions") throw new Error("expected listSubscriptions");
    assert.deepEqual(left.subscriptions, []);

    // The world channel is the default member channel (never in the explicit
    // subscription list, but still receivable unless suppressed).
    const world = await service.invoke("taskBoard", {
      action: "subscribe",
      taskId: "default",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    assert.equal(world.action, "subscribe");
    const afterWorld = await service.invoke("taskBoard", {
      action: "listSubscriptions",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    if (afterWorld.action !== "listSubscriptions") throw new Error("expected listSubscriptions");
    assert.deepEqual(afterWorld.subscriptions, [], "world channel is implicit, not explicit");
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});
