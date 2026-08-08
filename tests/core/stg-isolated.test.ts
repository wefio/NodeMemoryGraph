import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  copyLtgSubsetToStg,
  createStgStore,
  searchStgFirst,
  stgStorePath,
} from "../../src/core/stg.ts";
import { NmgStore } from "../../src/core/store.ts";
import { HashingVectorEmbedder } from "../../src/core/vector.ts";

/**
 * Design-driven tests for docs/stg-isolated-store.md (Phase 1 + 2).
 *
 * Phase 1: STG lives in a separate project-local SQLite file; deleting it
 *          must not touch LTG.
 * Phase 2: LTG content cached into STG carries `cached_from_ltg` markers,
 *          is driven by usage, and must never promote back (loop guard).
 */
function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"), new HashingVectorEmbedder());
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ── Phase 1: isolated, deletable project-local STG ──

test("Phase1: STG store is a separate file that can be deleted without touching LTG", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-iso-"));
  try {
    const store = new NmgStore(join(directory, "nmg.sqlite"), new HashingVectorEmbedder());
    const durable = store.remember({ statement: "Durable fact", nodeName: "durable" });
    assert.equal(durable.memory.residence, "ltg");
    store.close();

    // STG store path is derived from the LTG store path (project folder).
    const stgPath = join(directory, "nmg.stg.sqlite");
    const stg = new NmgStore(stgPath, new HashingVectorEmbedder());
    const provisional = stg.remember({
      statement: "Provisional task fact",
      nodeName: "provisional",
      residence: "stg",
    });
    assert.equal(provisional.memory.residence, "stg");
    stg.close();

    // Deleting the STG file must not affect the LTG store.
    rmSync(stgPath, { force: true });
    const reopened = new NmgStore(join(directory, "nmg.sqlite"), new HashingVectorEmbedder());
    assert.equal(reopened.search("Durable fact", { maxTier: 3 }).length, 1, "LTG survives STG deletion");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── Phase 2: cached_from_ltg marker and promotion loop guard ──

test("Phase2: cached_from_ltg memories never promote (loop guard)", () => {
  withStore((store) => {
    // A memory written with the cache marker (as the copy routine would).
    const cached = store.remember({
      statement: "LTG hot memory copied into STG",
      nodeName: "cached",
      residence: "stg",
      markers: [
        {
          kind: "cached_from_ltg",
          attributes: { sourceMemoryId: "ltg-mem-1", cachedAt: "2026-07-31" },
        },
      ],
    });
    assert.equal(cached.memory.residence, "stg");

    // Promotion pipeline must refuse cached copies (it already *is* LTG).
    // Contract: explicit throw — the caller must know a cache entry cannot
    // re-enter LTG as a new identity (copy cycle).
    assert.throws(
      () => store.promoteMemory(cached.memory.id, "cache promoted"),
      /cached_from_ltg/,
      "promoting a cached copy throws",
    );
  });
});

test("Phase2: usage-driven copy selects the used project memory", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-usage-"));
  const ltg = new NmgStore(join(directory, "nmg.sqlite"), new HashingVectorEmbedder());
  const stg = createStgStore(directory, new HashingVectorEmbedder());
  try {
    const hot = ltg.remember({
      statement: "Project atlas hot memory",
      nodeName: "hot",
      scope: { project: "atlas" },
    });
    const cold = ltg.remember({
      statement: "Project atlas cold memory",
      nodeName: "cold",
      scope: { project: "atlas" },
    });
    ltg.recordUsage([hot.memory.id]);

    assert.equal(copyLtgSubsetToStg(ltg, stg, { scope: { project: "atlas" }, limit: 1 }), 1);
    const copied = stg.search("atlas memory", { maxTier: 3, limit: 10 });
    const sourceIds = copied.flatMap((result) =>
      result.memory.markers.map((marker) => marker.attributes?.sourceMemoryId),
    );
    assert.ok(sourceIds.includes(hot.memory.id), "used memory copied");
    assert.ok(!sourceIds.includes(cold.memory.id), "unused memory not copied");
  } finally {
    ltg.close();
    stg.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Phase2: cache markers carry sourceMemoryId for authority resolution", () => {
  withStore((store) => {
    const marker = {
      kind: "cached_from_ltg",
      attributes: { sourceMemoryId: "ltg-authority-42", cachedAt: "2026-07-31" },
    } as const;
    const saved = store.remember({
      statement: "Cached copy",
      nodeName: "cache",
      residence: "stg",
      markers: [marker],
    });
    const markerKind = saved.memory.markers.find((m) => m.kind === "cached_from_ltg");
    assert.ok(markerKind, "marker persisted");
    assert.equal(markerKind.attributes?.sourceMemoryId, "ltg-authority-42");
    // The agent can resolve authority through nmg_get on the source ID;
    // the marker is the pointer.
    assert.ok(markerKind.attributes?.cachedAt);
  });
});

test("Phase1: stgStorePath derives a deletable project-local file", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-path-"));
  try {
    const path = stgStorePath(directory);
    assert.ok(path.startsWith(join(directory, ".nmg", "sessions")));
    assert.notEqual(path, stgStorePath(directory, "another-session"));
    const stg = createStgStore(directory, new HashingVectorEmbedder());
    stg.remember({ statement: "Local provisional", nodeName: "local" });
    stg.close();
    assert.ok(existsSync(path), "STG file exists");
    rmSync(path, { force: true });
    assert.ok(!existsSync(path), "STG file deletable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Phase2: copyLtgSubsetToStg copies usage-ranked project LTG with markers", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-copy-"));
  const ltg = new NmgStore(join(directory, "nmg.sqlite"), new HashingVectorEmbedder());
  const stg = createStgStore(directory, new HashingVectorEmbedder());
  try {
    // Project-scoped memories: one heavily used, one cold.
    const used = ltg.remember({
      statement: "Project atlas uses SQLite",
      nodeName: "atlas storage",
      scope: { project: "atlas" },
    });
    ltg.remember({
      statement: "Project atlas old note",
      nodeName: "atlas note",
      scope: { project: "atlas" },
    });
    // Different project: must NOT be copied.
    ltg.remember({
      statement: "Project nmg uses Pi",
      nodeName: "nmg runtime",
      scope: { project: "nmg" },
    });
    // Simulate usage: used memory gets more access.
    ltg.recordUsage([used.memory.id]);

    const written = copyLtgSubsetToStg(ltg, stg, {
      scope: { project: "atlas" },
      limit: 10,
    });
    assert.ok(written >= 1, `copied at least one (${written})`);
    const copied = stg.search("atlas", { maxTier: 3, limit: 20 });
    assert.ok(copied.length >= 1, "STG has copies");
    assert.ok(
      copied.every((r) => r.memory.markers.some((m) => m.kind === "cached_from_ltg")),
      "every copy carries cached_from_ltg",
    );
    const copiedStatements = copied.map((r) => r.memory.statement);
    assert.ok(copiedStatements.some((s) => s.includes("SQLite")), "project content copied");
    assert.ok(
      !copiedStatements.some((s) => s.includes("uses Pi")),
      "other project content NOT copied",
    );
    // The usage-ranked first memory is present (highest access_count).
    assert.ok(
      copied.some((r) => r.memory.markers.some((m) => m.attributes?.sourceMemoryId === used.memory.id)),
      "used memory copied with sourceMemoryId",
    );
    const countBefore = copied.length;
    assert.equal(
      copyLtgSubsetToStg(ltg, stg, { scope: { project: "atlas" }, limit: 10 }),
      0,
      "repeated copy is idempotent",
    );
    assert.equal(stg.search("atlas", { maxTier: 3, limit: 20 }).length, countBefore);
  } finally {
    ltg.close();
    stg.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Phase3: searchStgFirst returns STG hits directly and falls back to LTG", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-search-"));
  const ltg = new NmgStore(join(directory, "nmg.sqlite"), new HashingVectorEmbedder());
  const stg = createStgStore(directory, new HashingVectorEmbedder());
  try {
    const hot = ltg.remember({
      statement: "Project atlas hot memory",
      nodeName: "atlas hot",
      scope: { project: "atlas" },
    });
    copyLtgSubsetToStg(ltg, stg, { scope: { project: "atlas" }, limit: 10 });

    // STG hit → returned directly (local results present).
    const hit = searchStgFirst(ltg, stg, "hot memory");
    assert.ok(hit.results.length >= 1, "STG hit found");
    assert.ok(
      hit.results.some((r) => r.memory.markers.some((m) => m.kind === "cached_from_ltg")),
      "hit is the cached copy",
    );

    // LTG-only content (not copied) → fallback finds it.
    ltg.remember({
      statement: "Project atlas uncached deep memory",
      nodeName: "atlas deep",
      scope: { project: "atlas" },
    });
    const fallback = searchStgFirst(ltg, stg, "uncached deep memory", { qppThreshold: 2 });
    assert.ok(fallback.results.length >= 1, "LTG fallback found uncached content");
    assert.ok(
      fallback.results.some((result) => result.memory.statement.includes("uncached deep memory")),
      "fallback includes the authoritative LTG result",
    );

    const merged = searchStgFirst(ltg, stg, "Project atlas hot memory", { qppThreshold: 2 });
    const matching = merged.results.filter((result) => result.memory.statement === hot.memory.statement);
    assert.equal(matching.length, 1, "cached copy and LTG authority are deduplicated");
    assert.equal(matching[0]?.memory.id, hot.memory.id, "LTG authority wins the merge");
    assert.deepEqual(
      new Set(merged.activeGraph?.memoryIds),
      new Set(merged.results.map((result) => result.memory.id)),
      "the merged AG owns every visible STG/LTG result",
    );
    assert.deepEqual(
      new Set(merged.activeGraph?.selections.map((selection) => selection.memoryId)),
      new Set(merged.results.map((result) => result.memory.id)),
      "the merged AG keeps selection provenance for every visible result",
    );
  } finally {
    ltg.close();
    stg.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
