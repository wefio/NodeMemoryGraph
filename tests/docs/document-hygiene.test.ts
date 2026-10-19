import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkDocumentHygiene, DOCUMENT_HYGIENE_PATHS } from "../../scripts/document-hygiene.ts";

// These assertions decide only the mechanical ATX/fence/comment pilot contract.
test("document hygiene rejects empty ATX titles", () => {
  assert.match(checkDocumentHygiene("# Page\nBody\n##   \nBody\n").join("\n"), /empty heading.*3/);
});

test("document hygiene rejects empty sections including comment-only bodies", () => {
  const text = "# Page\n## First\n<!-- a maintenance note -->\n## Second\nBody\n";
  assert.match(checkDocumentHygiene(text).join("\n"), /empty section.*First/);
});

test("document hygiene rejects normalized duplicate siblings", () => {
  const text = "# Page\n## Same   title\nFirst\n## same title\nSecond\n";
  assert.match(checkDocumentHygiene(text).join("\n"), /duplicate sibling.*same title/i);
});

test("document hygiene preserves identical titles in different parent sections", () => {
  const text = "# Page\n## First\n### Details\nA\n## Second\n### Details\nB\n";
  assert.deepEqual(checkDocumentHygiene(text), []);
});

test("document hygiene counts child content but rejects an empty heading subtree", () => {
  assert.deepEqual(checkDocumentHygiene("# Page\n## Parent\n### Child\nBody\n"), []);
  assert.match(
    checkDocumentHygiene("# Page\n## Parent\n### Child\n").join("\n"),
    /empty section.*Parent/,
  );
});

test("document hygiene ignores backtick and tilde fenced headings", () => {
  for (const fence of ["```", "~~~~"]) {
    const text = `# Page\n## Example\n${fence}markdown\n##\n## Example\n${fence}\n## Other\nBody\n`;
    assert.deepEqual(checkDocumentHygiene(text), []);
  }
});

test("document hygiene ignores closing fences shorter than their opening fence", () => {
  const text = "# Page\n## Example\n````markdown\n```\n## Example\n````\n## Other\nBody\n";
  assert.deepEqual(checkDocumentHygiene(text), []);
});

test("document hygiene ignores commented headings without discarding literal code", () => {
  const text = "# Page\n## Example\n```html\n<!-- literal -->\n```\n<!--\n## Example\n##\n-->\n";
  assert.deepEqual(checkDocumentHygiene(text), []);
});

test("document hygiene permits distinct headings but cannot certify their prose", () => {
  assert.deepEqual(checkDocumentHygiene("# Page\n## One\nTODO\n## Two\nTODO\n"), []);
});

test("document hygiene roles and required workflow paths match both CI contracts", () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const text = readFileSync(new URL(`../../docs/${file}`, import.meta.url), "utf8");
    const row = text
      .split(/\r?\n/)
      .find(
        (line) => line.includes("unique normalized sibling") || line.includes("同级标题规范化"),
      );
    assert.ok(row, `${file}: missing hygiene policy row`);
    const paths = [...row.matchAll(/`([^`]+\.md)`/g)].map((match) => match[1]);
    assert.deepEqual(paths, ["docs/design/**/*.md", "skills/**/*.md", ...DOCUMENT_HYGIENE_PATHS]);
  }
});
