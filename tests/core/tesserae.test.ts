import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { TESSERA_REF_MARKER } from "../../src/core/types.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-tesserae-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("remember with tesserae writes rows and tessera_ref markers", () => {
  withStore((store) => {
    const result = store.remember({
      statement: "tesserae are an independent searchable source",
      nodeName: "tessera-test",
      scope: { project: "smoke" },
      tesserae: [
        {
          path: "src/core/types.ts",
          snippet: "export interface TesseraRecord",
          label: "TesseraRecord type",
          kind: "code",
        },
        { path: "docs/design.md", snippet: "## 3. Decisions", label: "design section" },
      ],
    });
    const memory = store.getMemory(result.memory.id);
    assert.ok(memory, "memory exists");
    const refs = (memory.markers ?? []).filter((marker) => marker.kind === TESSERA_REF_MARKER);
    assert.equal(refs.length, 2, "one tessera_ref marker per tessera");
    // Each marker carries the tessera id; rows are findable by id.
    const ids = refs.map((marker) => String(marker.attributes?.tesseraId));
    assert.equal(ids.length, 2);
    const byId = store.getTesseraeByIds(ids);
    assert.equal(byId.length, 2);
    const byPath = byId.find((tessera) => tessera.path === "src/core/types.ts");
    assert.ok(byPath, "tessera row carries the path");
    assert.equal(byPath?.label, "TesseraRecord type");
    assert.equal(byPath?.memoryId, result.memory.id);
  });
});

test("searchTesserae matches label and snippet via FTS", () => {
  withStore((store) => {
    store.remember({
      statement: "budget mechanism exists",
      nodeName: "tessera-budget",
      scope: { project: "smoke" },
      tesserae: [
        {
          path: "docs/design/design.md",
          snippet: "unified session budget",
          label: "unified budget section",
        },
      ],
    });
    const byLabel = store.searchTesserae("budget section", 5);
    assert.equal(byLabel.length, 1, "label term hits");
    assert.equal(byLabel[0]!.path, "docs/design/design.md");
    const bySnippet = store.searchTesserae("session budget", 5);
    assert.equal(bySnippet.length, 1, "snippet term hits");
  });
});

test("remember without tesserae writes no rows and no markers", () => {
  withStore((store) => {
    const result = store.remember({
      statement: "plain memory without tesserae",
      nodeName: "tessera-none",
      scope: { project: "smoke" },
    });
    const memory = store.getMemory(result.memory.id);
    assert.ok(memory);
    const refs = (memory.markers ?? []).filter((marker) => marker.kind === TESSERA_REF_MARKER);
    assert.equal(refs.length, 0);
    assert.equal(store.searchTesserae("plain memory", 5).length, 0);
  });
});

test("duplicate memory write does not duplicate tesserae", () => {
  withStore((store) => {
    const input = {
      statement: "duplicate tessera memory",
      nodeName: "tessera-dup",
      scope: { project: "smoke" },
      tesserae: [{ path: "a.ts", snippet: "export const x", label: "a" }],
    };
    const first = store.remember(input);
    const second = store.remember(input);
    assert.equal(first.memory.id, second.memory.id, "exact duplicate returns existing");
    assert.equal(store.searchTesserae("export const x", 10).length, 1, "one tessera row only");
  });
});
