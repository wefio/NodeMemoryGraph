import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";

import { verifyDocumentation } from "../../scripts/verify-docs.mts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-docs-"));
  const files: Record<string, string> = {
    "README.md": "# Project\n\n[中文](README.zh-CN.md)\n",
    "README.zh-CN.md": "# 项目\n\n[English](README.md)\n",
    "docs/README.md": "# Docs\n\n[中文](README.zh-CN.md)\n",
    "docs/README.zh-CN.md": "# 文档\n\n[English](README.md)\n",
    "docs/decisions/README.md": "# Decisions\n\n[中文](README.zh-CN.md)\n",
    "docs/decisions/README.zh-CN.md": "# 决策\n\n[English](README.md)\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("valid bilingual documentation surface passes", () => {
  const report = verifyDocumentation(fixture());
  assert.deepEqual(report.errors, []);
});

test("broken local links and missing H1 fail", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "broken.md"), "[missing](absent.md)\n");
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("missing H1")));
  assert.ok(report.errors.some((error) => error.includes("broken local link")));
});

test("implemented decisions require status and sections", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "incomplete.md"), "# Incomplete\n\n**Status:** proposed\n");
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("Status must match")));
  assert.ok(report.errors.some((error) => error.includes("missing section")));
});

test("a missing decision translation warns but does not fail", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "choice.md"),
    "# Choice\n\n**Status:** implemented\n\n## Problem\nP\n\n## Decision\nD\n\n" +
      "## Alternatives considered\nA\n\n## Consequences\nC\n",
  );
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((warning) => warning.includes("counterpart")));
});

test("a missing public bilingual index fails", () => {
  const root = fixture();
  rmSync(join(root, "docs", "README.zh-CN.md"));
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("missing public bilingual document")));
});

test("uncategorized documentation content at docs root fails", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "orphan.md"), "# Orphan\n");
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("must live in design/")));
});
