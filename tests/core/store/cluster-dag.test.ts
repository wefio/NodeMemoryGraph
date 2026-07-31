import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/**
 * Guard test for the NmgStore method-cluster split
 * (docs/store-cluster-split.md, phases 1–3).
 *
 * The store's methods are moved out of `src/core/store.ts` into one file
 * per cluster (`src/core/store/<cluster>.ts`), each exporting a mixin
 * `with<Cluster>(Base)`, and store.ts assembles the final class as
 *
 *   export class NmgStore
 *     extends withGraph(withRetrieval(withWrites(withMaintenance(NmgStoreBase)))) {}
 *
 * Pins the new boundary:
 *
 *   1. every cluster file exists and defines (exports) its `with<Cluster>`
 *      mixin and nothing else,
 *   2. every assigned method is defined inside exactly one cluster file
 *      (methods may not remain in store.ts or base.ts, and no cluster may
 *      define a method assigned to another cluster),
 *   3. no cluster file imports store.ts, base.ts or any other cluster —
 *      the module graph must stay acyclic (DAG),
 *   4. store.ts assembles the mixin chain in the fixed order and the base
 *      class lives in src/core/store/base.ts.
 *
 * Written BEFORE the split (Phase 1), so initially checks 1–2 are RED for
 * the cluster files — that is expected until Phase 2/3 are done. The test
 * is plain text: no compiler, no program, runs in milliseconds.
 */

const STORE = "src/core/store.ts";
const STORE_DIR = dirname(STORE);
const BASE_FILE = join(STORE_DIR, "store", "base.ts");
const BASE_ANCHOR = "NmgStoreBase";
const FINAL_ANCHOR = "NmgStore";

/** Cluster → methods assigned to it (single source of truth for the guard). */
const CLUSTERS: Record<string, string[]> = {
  graph: [
    "linkNodes",
    "getRelations",
    "mergeNodes",
    "splitNode",
    "getNodeTransform",
    "routeNodes",
    "routeNodesByVector",
    "trainRouter",
    "edgeStability",
    "nodeActivation",
    "relationActivation",
    "reconcileConsolidation",
    "consolidationEvents",
    "proposeTopologyChanges",
    "topologyProposals",
    "reviewTopologyProposal",
  ],
  retrieval: [
    "searchContext",
    "searchContextWithSecondPass",
    "getContext",
    "residentKernel",
    "recallCues",
    "search",
    "searchByVector",
    "searchByVectorCandidates",
    "searchHierarchyByVector",
    "searchLeafBlocks",
    "searchNodeFirst",
  ],
  writes: [
    "remember",
    "rememberInner",
    "addMemory",
    "appendHistory",
    "deriveMemory",
    "recordRejectedWrite",
    "recordUsage",
    "archiveSession",
    "getSessionArchive",
  ],
  maintenance: [
    "deleteMemory",
    "setMemoryStorageState",
    "retentionCandidates",
    "promoteMemory",
    "demoteMemory",
    "expireShortTermMemories",
    "memoryWriteEvents",
    "getHistoryBySourceMessage",
    "rebuildVectorIndex",
    "rebuildLeafBlocks",
    "rebuildDueLeafBlocks",
    "dirtyLeafNodeIds",
    "pendingIndexDelta",
    "acknowledgeIndexDelta",
    "beginEmbeddingIndex",
    "completeEmbeddingIndex",
    "failEmbeddingIndex",
    "embeddingIndexHealth",
    "contradictionNotes",
    "recordRetrievalTrace",
    "perfAggregates",
    "retrievalTracesCount",
    "pruneRetrievalTraces",
    "retrievalTrace",
    "recordActiveGraphUse",
    "recordConsolidationEvent",
    "rebalanceNode",
    "rebalanceDueNodes",
    "upsertNode",
  ],
};

const MIXIN_CHAIN_RE =
  /class\s+NmgStore\s+extends\s+withGraph\(\s*withRetrieval\(\s*withWrites\(\s*withMaintenance\(\s*NmgStoreBase\s*\)\s*\)\s*\)\s*\)/;

function methodDef(name: string, source: string, indent = 2): boolean {
  // Class method: `<indent>[protected ]name(` at class-member indent; also
  // matches multi-line signatures because only the first line needs the name.
  // `declare` field declarations are type-only placeholders (erased at
  // runtime, never real definitions) and must NOT match.
  const pad = " ".repeat(indent);
  return new RegExp(`^${pad}(?!declare\\b)(?:protected\\s+)?${name}\\s*\\(`, "m").test(source);
}

function exportDef(name: string, source: string): boolean {
  return new RegExp(
    `^export\\s+(?:async\\s+)?(?:function|const|class|type|interface|enum)\\s+${name}\\b`,
    "m",
  ).test(source);
}

/** Relative import specifiers a file uses ("./…" and "../…"). */
function relativeImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) out.push(match[1]!);
  return out;
}

function clusterFilePath(cluster: string): string {
  return join(STORE_DIR, "store", `${cluster}.ts`);
}

test("cluster split: every cluster file exists and exports only its with<Cluster> mixin", () => {
  for (const cluster of Object.keys(CLUSTERS)) {
    const file = clusterFilePath(cluster);
    const text = readFileSync(file, "utf8");
    const mixin = `with${cluster[0]!.toUpperCase()}${cluster.slice(1)}`;
    // 1. the mixin itself is exported.
    assert.match(
      text,
      new RegExp(`export\\s+function\\s+${mixin}\\s*<`, "m"),
      `${mixin} must be defined in ${file}`,
    );
    // 2. nothing else is exported at top level (no stray exports).
    const exports = [
      ...text.matchAll(
        /^export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/gm,
      ),
    ].map((m) => m[1]!);
    assert.deepEqual(exports, [mixin], `${file} must export only ${mixin}`);
  }
});

test("cluster split: every method lives in exactly one cluster, none left in store.ts", () => {
  const storeText = readFileSync(STORE, "utf8");
  const byFile = new Map<string, string>();
  for (const cluster of Object.keys(CLUSTERS)) {
    byFile.set(cluster, readFileSync(clusterFilePath(cluster), "utf8"));
  }
  for (const [cluster, methods] of Object.entries(CLUSTERS)) {
    for (const method of methods) {
      assert.ok(
        methodDef(method, byFile.get(cluster)!, 4),
        `${method} must be defined in ${clusterFilePath(cluster)}`,
      );
      // defined in exactly one cluster — never in a sibling cluster file.
      for (const [other, text] of byFile) {
        if (other !== cluster) {
          assert.ok(
            !methodDef(method, text, 4),
            `${method} must not be defined in ${clusterFilePath(other)}`,
          );
        }
      }
      // never still defined in the monolith.
      assert.ok(
        !methodDef(method, storeText, 2),
        `${method} must no longer be defined in ${STORE}`,
      );
    }
  }
});

test("cluster split: cluster files form a DAG (no imports of store.ts, base.ts or sibling clusters)", () => {
  const storeKey = resolve(STORE).toLowerCase();
  const baseKey = resolve(BASE_FILE).toLowerCase();
  for (const cluster of Object.keys(CLUSTERS)) {
    const file = clusterFilePath(cluster);
    const text = readFileSync(file, "utf8");
    for (const spec of relativeImports(text)) {
      const resolved = resolve(dirname(file), spec).toLowerCase();
      assert.notEqual(resolved, storeKey, `${file} must not import ${STORE} (cycle)`);
      assert.notEqual(resolved, baseKey, `${file} must not import ${BASE_FILE} (cycle)`);
      for (const other of Object.keys(CLUSTERS)) {
        if (other === cluster) continue;
        assert.notEqual(
          resolved,
          resolve(clusterFilePath(other)).toLowerCase(),
          `${file} must not import sibling cluster ${clusterFilePath(other)} (cycle)`,
        );
      }
    }
  }
});

test("cluster split: store.ts assembles the mixin chain in order", () => {
  const text = readFileSync(STORE, "utf8");
  const baseText = readFileSync(BASE_FILE, "utf8");
  assert.ok(exportDef(BASE_ANCHOR, baseText), `${BASE_ANCHOR} must be defined in ${BASE_FILE}`);
  assert.ok(
    text.includes(`import { ${BASE_ANCHOR} } from "./store/base.ts"`),
    `${STORE} must import ${BASE_ANCHOR} from ${BASE_FILE}`,
  );
  assert.ok(exportDef(FINAL_ANCHOR, text), `${FINAL_ANCHOR} must be defined in ${STORE}`);
  // NmgStore must extend the mixin chain with every mixin, in fixed order.
  assert.ok(
    MIXIN_CHAIN_RE.test(text),
    `${STORE} must define class NmgStore extends withGraph(withRetrieval(withWrites(withMaintenance(NmgStoreBase))))`,
  );
});
