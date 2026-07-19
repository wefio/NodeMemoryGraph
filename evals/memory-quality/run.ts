import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { NmgStore } from "../../src/core/store.ts";
import { assessMemoryWrite } from "../../src/core/write-policy.ts";

interface Result {
  category: string;
  passed: boolean;
  latencyMs: number;
  detail: string;
}

const directory = mkdtempSync(join(tmpdir(), "nmg-quality-eval-"));
const store = new NmgStore(join(directory, "nmg.sqlite"));
const results: Result[] = [];

try {
  measure("temporal", () => {
    const oldState = store.remember({
      statement: "Project Atlas currently uses Python 3.11",
      nodeName: "Atlas Python version",
      memoryType: "state",
      stateKey: "runtime.python",
      scope: { project: "Atlas" },
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    const currentState = store.remember({
      statement: "Project Atlas currently uses Python 3.12",
      nodeName: "Atlas Python version",
      memoryType: "state",
      stateKey: "runtime.python",
      scope: { project: "Atlas" },
      validFrom: "2026-07-01T00:00:00.000Z",
    });
    const current = store.search("Atlas current Python", { maxTier: 3, limit: 5 });
    return {
      passed: current.some((item) => item.memory.id === currentState.memory.id) &&
        !current.some((item) => item.memory.id === oldState.memory.id),
      detail: "new state supersedes the old state in ordinary retrieval",
    };
  });

  measure("aggregation", () => {
    const boots = store.remember({
      statement: "The user returned hiking boots",
      nodeName: "Shopping returns",
      memoryType: "event",
    });
    const mug = store.remember({
      statement: "The user returned a ceramic mug",
      nodeName: "Shopping returns",
      memoryType: "event",
    });
    const aggregate = store.deriveMemory({
      statement: "The user returned two items: hiking boots and a ceramic mug",
      nodeName: "Shopping return summary",
      sourceMemoryIds: [boots.memory.id, mug.memory.id],
      derivation: "Aggregation of two independently recorded return events",
    });
    return {
      passed: aggregate.memory.evidenceIds.length >= 2 &&
        store.search("two returned items", { maxTier: 3 })[0]?.memory.id ===
          aggregate.memory.id,
      detail: "derived memory preserves both source evidence chains",
    };
  });

  measure("conflict", () => {
    const left = store.remember({
      statement: "The deployment region is Frankfurt",
      nodeName: "Deployment region A",
    });
    const right = store.remember({
      statement: "The deployment region is Singapore",
      nodeName: "Deployment region B",
      evidenceRole: "contradict",
    });
    store.linkNodes({
      sourceNodeId: left.node.id,
      targetNodeId: right.node.id,
      type: "contradicts",
      evidenceIds: [left.history.id, right.history.id],
    });
    const context = store.searchContext("deployment region", {
      maxTier: 3,
      limit: 6,
      graphHops: 1,
    });
    return {
      passed: context.results.some((item) => item.memory.id === left.memory.id) &&
        context.results.some((item) => item.memory.id === right.memory.id) &&
        context.relations.some((relation) => relation.type === "contradicts"),
      detail: "both claims and their typed contradiction remain visible",
    };
  });

  measure("multi-hop", () => {
    const project = store.remember({ statement: "Project Comet", nodeName: "Comet" });
    const simulator = store.remember({ statement: "Comet uses Gazebo", nodeName: "Gazebo" });
    const incident = store.remember({
      statement: "Gazebo recovered with software rendering",
      nodeName: "Rendering incident",
      tier: 2,
    });
    store.linkNodes({
      sourceNodeId: project.node.id,
      targetNodeId: simulator.node.id,
      type: "depends_on",
    });
    store.linkNodes({
      sourceNodeId: simulator.node.id,
      targetNodeId: incident.node.id,
      type: "related_to",
    });
    const relations = store.getRelations([project.node.id], 2);
    return {
      passed: relations.some((edge) => edge.targetNodeId === incident.node.id),
      detail: "two-hop graph traversal reaches indirectly related evidence",
    };
  });

  measure("exact-detail", () => {
    for (let index = 0; index < 550; index += 1) {
      store.remember({
        statement: `Routine filler note ${index}`,
        nodeName: `Filler ${index}`,
        tier: 0,
      });
    }
    const target = store.remember({
      statement: "The retired internal codename was opaline-cicada-7429",
      nodeName: "Retired codename",
      tier: 3,
    });
    const found = store.search("opaline-cicada-7429", {
      maxTier: 3,
      limit: 2,
      retrievalMode: "fts5",
    });
    return {
      passed: found[0]?.memory.id === target.memory.id,
      detail: "FTS retrieves an exact cold detail beyond the hot candidate window",
    };
  });

  measure("privacy", () => {
    const assessment = assessMemoryWrite({
      statement: "The API key is sk-test-nmg-123456",
      memoryType: "fact",
    });
    return {
      passed: !assessment.allowed && assessment.reason === "secret",
      detail: "deterministic harness policy rejects credential-like semantic writes",
    };
  });

  measure("memory-pollution", () => {
    const transient = assessMemoryWrite({
      statement: "For this response only, answer briefly.",
      memoryType: "preference",
    });
    const stable = assessMemoryWrite({
      statement: "The user prefers concise answers in future sessions.",
      memoryType: "preference",
    });
    return {
      passed: !transient.allowed && stable.allowed,
      detail: "temporary instructions are rejected while durable preferences pass",
    };
  });
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

const report = {
  cases: results.length,
  passed: results.filter((result) => result.passed).length,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.passed !== report.cases) process.exitCode = 1;

function measure(
  category: string,
  run: () => { passed: boolean; detail: string },
): void {
  const started = performance.now();
  const result = run();
  results.push({
    category,
    passed: result.passed,
    latencyMs: performance.now() - started,
    detail: result.detail,
  });
}
