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

test("the parts shelf fails when it names a part src/rcp no longer exports", () => {
  const root = fixture();
  mkdirSync(join(root, "src", "rcp"), { recursive: true });
  mkdirSync(join(root, "docs", "guides"), { recursive: true });
  writeFileSync(join(root, "src", "rcp", "index.ts"), "export function reconcileOnce(): void {}\n");
  writeFileSync(
    join(root, "docs", "guides", "parts.md"),
    "# Shelf\n\n### `reconcileOnce(request)`\n\n### `removedPart()`\n",
  );
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("'removedPart' is not exported")));
  assert.ok(!report.errors.some((error) => error.includes("'reconcileOnce' is not exported")));
});

test("valid bilingual documentation surface passes", () => {
  const report = verifyDocumentation(fixture());
  assert.deepEqual(report.errors, []);
});

test("internal notes with broken links or no H1 warn without blocking", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "broken.md"), "[missing](absent.md)\n");
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((warning) => warning.includes("missing H1")));
  assert.ok(report.warnings.some((warning) => warning.includes("broken local link")));
});

test("canonical entry documents fail on a broken local link", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "README.md"), "# Docs\n\n[missing](absent.md)\n");
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("broken local link")));
});

test("implemented decisions require status and sections", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "2026-08-24-incomplete.md"),
    "# Incomplete\n\n**Status:** proposed\n",
  );
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("Status must match")));
  assert.ok(report.errors.some((error) => error.includes("missing section")));
});

test("a missing decision translation warns but does not fail", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "2026-08-24-choice.md"),
    "# Choice\n\n**Status:** implemented\n\n## Problem\nP\n\n## Decision\nD\n\n" +
      "## Alternatives considered\nA\n\n## Consequences\nC\n",
  );
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((warning) => warning.includes("counterpart")));
});

test("decision filenames and lifecycle locations are unique", () => {
  const root = fixture();
  const content =
    "# Choice\n\n**Status:** implemented\n\n## Problem\nP\n\n## Decision\nD\n\n" +
    "## Alternatives considered\nA\n\n## Consequences\nC\n";
  for (const lifecycle of ["implemented", "archived"]) {
    const directory = join(root, "docs", "decisions", lifecycle);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "bad name.md"), content);
    writeFileSync(join(directory, "2026-08-24-choice.md"), content);
  }
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("YYYY-MM-DD-kebab-case")));
  assert.ok(report.errors.some((error) => error.includes("multiple lifecycle directories")));
});

test("decision status is exact and required sections are non-empty", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "2026-08-24-choice.md"),
    "# Choice\n\n**Status:** implemented-but-unverified\n\n## Problem\n\n## Decision\nD\n\n" +
      "## Alternatives considered\nA\n\n## Consequences\nC\n",
  );
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("Status must match")));
  assert.ok(report.errors.some((error) => error.includes("empty section 'Problem")));
});

test("Skill frontmatter name and description are contractual", () => {
  const root = fixture();
  const directory = join(root, "skills", "memory-tool");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    "---\nname: wrong-name\ndescription:\n---\n\n# Memory tool\n",
  );
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("Skill name must match directory")));
  assert.ok(report.errors.some((error) => error.includes("Skill description must be non-empty")));
});

test("bilingual decisions warn when they do not link to each other", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  const body =
    "**Status:** implemented\n\n## Problem\nP\n\n## Decision\nD\n\n" +
    "## Alternatives considered\nA\n\n## Consequences\nC\n";
  writeFileSync(join(directory, "2026-08-24-choice.md"), `# Choice\n\n${body}`);
  writeFileSync(join(directory, "2026-08-24-choice.zh-CN.md"), `# 选择\n\n${body}`);
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((warning) => warning.includes("must link to each other")));
});

test("undated experiment filenames are advisory", () => {
  const root = fixture();
  const directory = join(root, "docs", "experiments");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "evaluation.md"), "# Evaluation\n");
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((warning) => warning.includes("should end in -YYYY-MM-DD")));
});

test("a missing public bilingual index fails", () => {
  const root = fixture();
  rmSync(join(root, "docs", "README.zh-CN.md"));
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("missing public bilingual document")));
});

test("uncategorized documentation content at docs root warns", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "orphan.md"), "# Orphan\n");
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((warning) => warning.includes("must live in design/")));
});

test("decision header fields are a closed, unique set", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  const body =
    "## Problem\nP\n\n## Decision\nD\n\n## Alternatives considered\nA\n\n## Consequences\nC\n";
  writeFileSync(
    join(directory, "2026-08-24-unknown.md"),
    `# Unknown\n\n**Status:** implemented\n**Branch:** x\n\n${body}`,
  );
  writeFileSync(
    join(directory, "2026-08-24-duplicate.md"),
    `# Duplicate\n\n**Status:** implemented\n**Status:** rejected\n\n${body}`,
  );
  writeFileSync(
    join(directory, "2026-08-24-allowed.md"),
    `# Allowed\n\n**Status:** implemented\n**Relates to:** [x](../../README.md)\n\n${body}`,
  );
  writeFileSync(
    join(directory, "2026-08-24-archived.md"),
    `# Archived\n\n**Status:** implemented\n**Archived:** 2026-08-24\n\n${body}`,
  );
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("unknown header field '**Branch:**'")));
  assert.ok(report.errors.some((error) => error.includes("appears 2 times")));
  assert.ok(report.errors.some((error) => error.includes("only valid in archived/")));
  assert.ok(!report.errors.some((error) => error.includes("2026-08-24-allowed.md")));
});

test("a header field below the first section is not a header field", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "2026-08-24-late.md"),
    "# Late\n\n## Problem\nP\n\n**Status:** implemented\n\n## Decision\nD\n\n" +
      "## Alternatives considered\nA\n\n## Consequences\nC\n",
  );
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("missing required header field")));
});

test("implemented decisions reject every proposal-era heading", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  const headings = ["Proposal", "Plan", "Acceptance criteria"];
  headings.forEach((heading, index) => {
    writeFileSync(
      join(directory, `2026-08-2${index}-banned.md`),
      `# Banned\n\n**Status:** implemented\n\n## Problem\nP\n\n## Decision\nD\n\n` +
        `## Alternatives considered\nA\n\n## ${heading}\nB\n\n## Consequences\nC\n`,
    );
  });
  const report = verifyDocumentation(root);
  for (const heading of headings) {
    assert.ok(
      report.errors.some((error) => error.includes(`proposal-era heading '${heading}'`)),
      `expected a failure for '${heading}'`,
    );
  }
});

test("the decision summary counts non-empty Deferred sections", () => {
  const root = fixture();
  const directory = join(root, "docs", "decisions", "implemented");
  mkdirSync(directory, { recursive: true });
  const body =
    "**Status:** implemented\n\n## Problem\nP\n\n## Decision\nD\n\n" +
    "## Alternatives considered\nA\n\n";
  writeFileSync(
    join(directory, "2026-08-24-open.md"),
    `# Open\n\n${body}## Deferred\n- remaining work\n\n## Consequences\nC\n`,
  );
  writeFileSync(
    join(directory, "2026-08-24-done.md"),
    `# Done\n\n${body}## Deferred\n\nNone.\n\n## Consequences\nC\n`,
  );
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.decisions, { implemented: 2, open: 1 });
});

test("design documents accept only the closed header field set and the status enum", () => {
  const root = fixture();
  const directory = join(root, "docs", "design");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "bad-design.md"),
    "# Bad\n\n**Status:** implemented across core protocol\n**Owner:** someone\n\n## Body\n",
  );
  const report = verifyDocumentation(root);
  assert.ok(
    report.errors.some((error) => error.includes("is not one of draft, current, superseded")),
  );
  assert.ok(report.errors.some((error) => error.includes("unknown header field '**Owner:**'")));
});

test("a superseded design must live in archived/ and name its successor", () => {
  const root = fixture();
  const directory = join(root, "docs", "design");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "dead-design.md"), "# Dead\n\n**Status:** superseded\n\n## Body\n");
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("belongs in docs/design/archived/")));
  assert.ok(report.errors.some((error) => error.includes("needs a '**Superseded by:**' link")));
});

test("documents in design/archived/ must be superseded", () => {
  const root = fixture();
  const directory = join(root, "docs", "design", "archived");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "live-design.md"), "# Live\n\n**Status:** current\n\n## Body\n");
  const report = verifyDocumentation(root);
  assert.ok(report.errors.some((error) => error.includes("must be superseded")));
});

test("a current design and an archived superseded design pass", () => {
  const root = fixture();
  mkdirSync(join(root, "docs", "design", "archived"), { recursive: true });
  writeFileSync(
    join(root, "docs", "design", "live-design.md"),
    "# Live\n\n**Status:** current — calibrated later\n**Related:** [Old](archived/old-design.md)\n\n## Body\n",
  );
  writeFileSync(
    join(root, "docs", "design", "archived", "old-design.md"),
    "# Old\n\n**Status:** superseded\n**Superseded by:** [Live](../live-design.md)\n\n## Body\n",
  );
  const report = verifyDocumentation(root);
  assert.deepEqual(report.errors, []);
});
