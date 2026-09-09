import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkGlossary, resolveTerm } from "../../tools/glossary-check.ts";

const BASE_FILES: Record<string, string> = {
  "docs/concept-map.md": "# Concept map\n",
  "docs/owner.md": "# Alpha\n",
};

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(glossary: string, files = BASE_FILES): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-glossary-"));
  write(root, "docs/glossary.yaml", glossary);
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  return root;
}

function withFixture(
  t: test.TestContext,
  glossary: string,
  run: (root: string) => void,
  files = BASE_FILES,
): void {
  const root = fixture(glossary, files);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root);
}

const VALID = `version: 1
conceptMap: docs/concept-map.md
terms:
  - term: alpha
    aliases: [a, 甲]
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
`;

test("the repository glossary resolves every term to a real owner heading", () => {
  const report = checkGlossary();
  assert.deepEqual(report.errors, []);
  assert.ok(report.terms >= 10, `expected the process vocabulary, got ${report.terms}`);
});

test("a missing glossary fails closed", (t) => {
  withFixture(t, VALID, (root) => {
    rmSync(join(root, "docs", "glossary.yaml"));
    assert.deepEqual(checkGlossary(root).errors, ["docs/glossary.yaml: missing"]);
  });
});

test("unknown top-level and term fields fail closed", (t) => {
  withFixture(t, `${VALID}extra: 1\n`, (root) => {
    assert.match(checkGlossary(root).errors.join("\n"), /unknown top-level field 'extra'/u);
  });
  withFixture(
    t,
    `version: 1
conceptMap: docs/concept-map.md
terms:
  - term: alpha
    aliases: [a]
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
    note: nope
`,
    (root) => {
      assert.match(checkGlossary(root).errors.join("\n"), /unknown field 'note'/u);
    },
  );
});

test("an owner that does not exist fails closed", (t) => {
  withFixture(t, VALID.replace("docs/owner.md", "docs/missing.md"), (root) => {
    assert.match(checkGlossary(root).errors.join("\n"), /is not an existing file/u);
  });
});

test("an anchor that is not a heading fails closed", (t) => {
  withFixture(
    t,
    VALID,
    (root) => {
      assert.match(checkGlossary(root).errors.join("\n"), /is not a heading/u);
    },
    { ...BASE_FILES, "docs/owner.md": "Alpha appears in prose only.\n" },
  );
});

test("two terms claiming the same name fail closed", (t) => {
  withFixture(
    t,
    `version: 1
conceptMap: docs/concept-map.md
terms:
  - term: alpha
    aliases: [a]
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
  - term: Alpha
    aliases: [b]
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
`,
    (root) => {
      assert.match(checkGlossary(root).errors.join("\n"), /already claimed by 'alpha'/u);
    },
  );
});

test("an alias claimed twice, or equal to another term, fails closed", (t) => {
  const twoTerms = (second: string): string => `version: 1
conceptMap: docs/concept-map.md
terms:
  - term: alpha
    aliases: [a]
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
${second}`;
  withFixture(
    t,
    twoTerms(`  - term: beta
    aliases: [a]
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
`),
    (root) => {
      assert.match(checkGlossary(root).errors.join("\n"), /already claimed by 'alpha'/u);
    },
  );
  withFixture(
    t,
    twoTerms(`  - term: beta
    aliases: [alpha]
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
`),
    (root) => {
      assert.match(checkGlossary(root).errors.join("\n"), /already claimed by 'alpha'/u);
    },
  );
});

test("a deprecated term needs a declared successor", (t) => {
  withFixture(
    t,
    `version: 1
conceptMap: docs/concept-map.md
terms:
  - term: old
    aliases: []
    owner: docs/owner.md
    anchor: Alpha
    status: deprecated
`,
    (root) => {
      assert.match(checkGlossary(root).errors.join("\n"), /needs a 'successor'/u);
    },
  );
  withFixture(
    t,
    `version: 1
conceptMap: docs/concept-map.md
terms:
  - term: old
    aliases: []
    owner: docs/owner.md
    anchor: Alpha
    status: deprecated
    successor: alpha
  - term: alpha
    aliases: []
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
`,
    (root) => {
      assert.deepEqual(checkGlossary(root).errors, []);
    },
  );
  withFixture(
    t,
    `version: 1
conceptMap: docs/concept-map.md
terms:
  - term: old
    aliases: []
    owner: docs/owner.md
    anchor: Alpha
    status: deprecated
    successor: ghost
`,
    (root) => {
      assert.match(checkGlossary(root).errors.join("\n"), /is not a declared term/u);
    },
  );
});

test("resolveTerm maps an alias to the same home as its term", (t) => {
  withFixture(t, VALID, (root) => {
    const byTerm = resolveTerm("alpha", root);
    const byAlias = resolveTerm("甲", root);
    assert.equal(byAlias?.term, "alpha");
    assert.equal(byAlias?.owner, byTerm?.owner);
    assert.equal(byAlias?.anchor, byTerm?.anchor);
    assert.equal(resolveTerm("nothing", root), undefined);
  });
});
