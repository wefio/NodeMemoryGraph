import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { ANCHOR_REF_MARKER } from "../../src/core/types.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-anchors-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("remember with anchors writes rows and anchor_ref markers", () => {
  withStore((store) => {
    const result = store.remember({
      statement: "anchors are an independent searchable source",
      nodeName: "anchor-test",
      scope: { project: "smoke" },
      anchors: [
        {
          path: "src/core/types.ts",
          snippet: "export interface AnchorRecord",
          label: "AnchorRecord type",
          kind: "code",
        },
        { path: "docs/design.md", snippet: "## 3. Decisions", label: "design section" },
      ],
    });
    const memory = store.getMemory(result.memory.id);
    assert.ok(memory, "memory exists");
    const refs = (memory.markers ?? []).filter((marker) => marker.kind === ANCHOR_REF_MARKER);
    assert.equal(refs.length, 2, "one anchor_ref marker per anchor");
    // Each marker carries the anchor id; rows are findable by id.
    const ids = refs.map((marker) => String(marker.attributes?.anchorId));
    assert.equal(ids.length, 2);
    const byId = store.getAnchorsByIds(ids);
    assert.equal(byId.length, 2);
    const byPath = byId.find((anchor) => anchor.path === "src/core/types.ts");
    assert.ok(byPath, "anchor row carries the path");
    assert.equal(byPath?.label, "AnchorRecord type");
    assert.equal(byPath?.memoryId, result.memory.id);
  });
});

test("searchAnchors matches label and snippet via FTS", () => {
  withStore((store) => {
    store.remember({
      statement: "budget mechanism exists",
      nodeName: "anchor-budget",
      scope: { project: "smoke" },
      anchors: [
        {
          path: "docs/design/design.md",
          snippet: "unified session budget",
          label: "unified budget section",
        },
      ],
    });
    const byLabel = store.searchAnchors("budget section", 5);
    assert.equal(byLabel.length, 1, "label term hits");
    assert.equal(byLabel[0]!.path, "docs/design/design.md");
    const bySnippet = store.searchAnchors("session budget", 5);
    assert.equal(bySnippet.length, 1, "snippet term hits");
  });
});

test("remember without anchors writes no rows and no markers", () => {
  withStore((store) => {
    const result = store.remember({
      statement: "plain memory without anchors",
      nodeName: "anchor-none",
      scope: { project: "smoke" },
    });
    const memory = store.getMemory(result.memory.id);
    assert.ok(memory);
    const refs = (memory.markers ?? []).filter((marker) => marker.kind === ANCHOR_REF_MARKER);
    assert.equal(refs.length, 0);
    assert.equal(store.searchAnchors("plain memory", 5).length, 0);
  });
});

test("duplicate memory write does not duplicate anchors", () => {
  withStore((store) => {
    const input = {
      statement: "duplicate anchor memory",
      nodeName: "anchor-dup",
      scope: { project: "smoke" },
      anchors: [{ path: "a.ts", snippet: "export const x", label: "a" }],
    };
    const first = store.remember(input);
    const second = store.remember(input);
    assert.equal(first.memory.id, second.memory.id, "exact duplicate returns existing");
    assert.equal(store.searchAnchors("export const x", 10).length, 1, "one anchor row only");
  });
});
