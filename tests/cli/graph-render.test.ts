import assert from "node:assert/strict";
import test from "node:test";

import {
  exportGraphHtml,
  loadGraphTemplates,
  renderGraphHtml,
} from "../../src/cli/graph-render.ts";
import type { GraphData } from "../../src/cli/graph-data.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NmgService } from "../../src/cli/service.ts";

function sampleData(): GraphData {
  return {
    generatedAt: "2026-08-12T00:00:00.000Z",
    nodes: [
      {
        id: "n1",
        name: "Atlas architecture",
        kind: "project",
        status: "active",
        residence: "ltg",
        summary: "",
        memoryCount: 1,
        statements: ["Offline-first."],
        degree: 0,
      },
    ],
    edges: [],
  };
}

test("renderGraphHtml inlines style, script, and escaped data", () => {
  const templates = { html: "<s><!--NMG_STYLE--></s><d><!--NMG_DATA--></d><j><!--NMG_SCRIPT--></j>", css: "CSS", js: "JS" };
  const data = sampleData();
  data.nodes[0]!.statements = ["breaks </script> tags"];
  const html = renderGraphHtml(data, templates);
  assert.ok(html.includes("<s>CSS</s>"));
  assert.ok(html.includes("<j>JS</j>"));
  assert.ok(!html.includes("<!--NMG_"), "all placeholders were replaced");
  // `</` must be escaped so a statement cannot close the inline script early.
  assert.ok(!html.includes("</script> tags"));
  assert.ok(html.includes("<\\/script> tags"));
  const payload = html.match(/<d>(.*)<\/d>/)![1]!;
  assert.deepEqual(JSON.parse(payload), data);
});

test("loadGraphTemplates resolves the bundled assets relative to the module", () => {
  const templates = loadGraphTemplates();
  assert.ok(templates.html.includes("<!--NMG_STYLE-->"));
  assert.ok(templates.html.includes("<!--NMG_DATA-->"));
  assert.ok(templates.html.includes("<!--NMG_SCRIPT-->"));
  assert.ok(templates.js.includes("NmgGraph"));
  assert.ok(templates.css.includes(".tooltip"));
});

test("exportGraphHtml writes a self-contained page from a database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-graph-export-"));
  const databasePath = join(directory, "nmg.sqlite");
  const outputPath = join(directory, "graph.html");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    await service.invoke("remember", {
      statement: "The Atlas project must remain offline-first.",
      nodeName: "Atlas architecture",
      scope: { project: "atlas" },
    });
    const written = exportGraphHtml(databasePath, outputPath);
    assert.equal(written, outputPath);
    const html = readFileSync(outputPath, "utf8");
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("Atlas architecture"));
    assert.ok(html.includes('NmgGraph.mount(document.getElementById("app"), NMG_DATA)'));
    // Self-contained: no external script or stylesheet references.
    assert.ok(!html.includes('src="http'));
    assert.ok(!html.includes('href="http'));
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
