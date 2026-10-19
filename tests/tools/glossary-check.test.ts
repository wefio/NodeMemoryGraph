import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkGlossary, queryTerms, resolveTerm } from "../../tools/glossary-check.ts";

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

test("a corpus with neither legacy pointers nor definitions fails closed", (t) => {
  withFixture(t, VALID, (root) => {
    rmSync(join(root, "docs", "glossary.yaml"));
    assert.match(checkGlossary(root).errors.join("\n"), /no registered sources/u);
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

function definitionYaml(namespace: string, id = "concept", term = "shared concept"): string {
  return `version: 2
namespace: ${namespace}
terms:
  - id: ${namespace}.${id}
    term: ${term}
    aliases: [共同概念]
    definition: A definition maintained by this topic.
    owner: docs/owner.md
    anchor: Alpha
    status: canonical
`;
}

function wordDefinitionYaml(namespace: string, term = "shared concept"): string {
  return definitionYaml(namespace).replace(
    `  - id: ${namespace}.concept\n    term: shared concept`,
    `  - term: ${term}`,
  );
}

const LEFT = "docs/design/left/local.terms.yaml";
const RIGHT = "docs/design/right/local.terms.yaml";

test("distributed YAML definitions are discovered without a central listing", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    assert.equal(checkGlossary(root).terms, 2);
    assert.deepEqual(checkGlossary(root).errors, []);
    const found = queryTerms("left.topic.concept", root);
    assert.equal(found.matches[0]?.definition, "A definition maintained by this topic.");
    assert.equal(found.matches[0]?.source, LEFT);
    assert.deepEqual(found.sources, ["docs/glossary.yaml", LEFT]);
    assert.equal(resolveTerm("甲", root)?.term, "alpha");
    assert.equal(resolveTerm("共同概念", root)?.id, "left.topic.concept");
  });
});

test("distributed definitions remain discoverable after retiring the legacy index", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    rmSync(join(root, "docs/glossary.yaml"));
    assert.deepEqual(checkGlossary(root).errors, []);
    const found = queryTerms("共同概念", root);
    assert.deepEqual(found.sources, [LEFT]);
    assert.equal(found.matches[0]?.id, "left.topic.concept");
  });
});

test("a present malformed legacy source still invalidates a distributed catalog", (t) => {
  withFixture(t, "version: 1\nterms: []\n", (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    const found = queryTerms("left.topic.concept", root);
    assert.ok(found.errors.length > 0);
    assert.deepEqual(found.matches, []);
  });
});

test("cross-namespace aliases return candidates rather than an arbitrary owner", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    write(root, RIGHT, definitionYaml("right.topic"));
    assert.deepEqual(checkGlossary(root).errors, []);
    assert.equal(queryTerms("共同概念", root).matches.length, 2);
    assert.equal(resolveTerm("共同概念", root), undefined);
    const scoped = queryTerms("共同概念", root, { namespace: "right.topic" });
    assert.deepEqual(
      scoped.matches.map((entry) => entry.id),
      ["right.topic.concept"],
    );
  });
});

test("aggregate checks reject duplicate IDs and namespace-local alias collisions", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    write(root, RIGHT, definitionYaml("left.topic"));
    assert.match(checkGlossary(root).errors.join("\n"), /duplicate ID/u);
    write(root, RIGHT, definitionYaml("left.topic", "other", "another concept"));
    assert.match(checkGlossary(root).errors.join("\n"), /already claimed.*left.topic/u);
  });
});

test("definition schemas reject malformed IDs, missing semantics and unknown fields", (t) => {
  const valid = definitionYaml("left.topic");
  const cases = [
    [valid.replace("left.topic.concept", "right.topic.concept"), /ID.*namespace/u],
    [valid.replace("namespace: left.topic", "namespace: invalid namespace"), /namespace/u],
    [valid.replace("    definition: A definition maintained by this topic.\n", ""), /definition/u],
    [valid + "extra: true\n", /unknown top-level field/u],
    [
      valid.replace("    status: canonical", "    status: canonical\n    extra: true"),
      /unknown field/u,
    ],
  ] as const;
  for (const [text, expected] of cases) {
    withFixture(t, VALID, (root) => {
      write(root, LEFT, text);
      assert.match(checkGlossary(root).errors.join("\n"), expected);
    });
  }
});

test("local discovery stays in its directory and reports only that searched corpus", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    write(root, RIGHT, "malformed: [\n");
    assert.match(checkGlossary(root).errors.join("\n"), /invalid YAML/u);
    const found = queryTerms("共同概念", root, { within: "docs/design/left" });
    assert.deepEqual(found.errors, []);
    assert.deepEqual(found.sources, [LEFT]);
    assert.equal(found.matches.length, 1);
    const missed = queryTerms("elsewhere", root, { within: "docs/design/left" });
    assert.equal(missed.scope, "docs/design/left");
    assert.equal(missed.matches.length, 0);
    assert.deepEqual(missed.sources, [LEFT]);
  });
});

test("empty and escaping local discovery scopes fail instead of producing empty success", (t) => {
  withFixture(t, VALID, (root) => {
    mkdirSync(join(root, "docs/design/empty"), { recursive: true });
    assert.match(
      queryTerms("alpha", root, { within: "docs/design/empty" }).errors.join("\n"),
      /no registered sources/u,
    );
    assert.match(
      queryTerms("alpha", root, { within: "../" }).errors.join("\n"),
      /scope.*repository/u,
    );
  });
});

test("a broken catalog cannot resolve a lucky matching legacy term", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic") + "extra: true\n");
    assert.equal(resolveTerm("alpha", root), undefined);
    assert.ok(queryTerms("alpha", root).errors.length > 0);
  });
});

test("deprecated distributed terms require a registered successor ID", (t) => {
  withFixture(t, VALID, (root) => {
    write(
      root,
      LEFT,
      definitionYaml("left.topic", "old").replace(
        "status: canonical",
        "status: deprecated\n    successor: left.topic.new",
      ),
    );
    assert.match(checkGlossary(root).errors.join("\n"), /successor.*not a declared/u);
    write(
      root,
      RIGHT,
      definitionYaml("left.topic", "new", "new concept").replace(
        "aliases: [共同概念]",
        "aliases: []",
      ),
    );
    assert.deepEqual(checkGlossary(root).errors, []);
  });
});

test("the actual glossary CLI refuses ambiguity and reports bounded misses", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    write(root, RIGHT, definitionYaml("right.topic"));
    const program = fileURLToPath(new URL("../../tools/glossary-check.ts", import.meta.url));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--experimental-strip-types", program, ...args], {
        cwd: root,
        encoding: "utf8",
      });
    const legacy = run("--resolve", "甲");
    assert.equal(legacy.status, 0);
    assert.equal(legacy.stdout, "alpha\tdocs/owner.md\tAlpha\n");
    assert.match(
      queryTerms("甲", root, { namespace: "" }).errors.join("\n"),
      /namespace must be non-empty/u,
    );
    const emptyNamespace = run("--resolve", "甲", "--namespace", "");
    assert.equal(emptyNamespace.status, 1);
    assert.match(emptyNamespace.stderr, /namespace must be non-empty/u);
    const ambiguous = run("--resolve", "共同概念");
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /ambiguous.*left.topic.*right.topic/su);
    const scoped = run("--resolve", "共同概念", "--namespace", "right.topic");
    assert.equal(scoped.status, 0);
    assert.match(scoped.stdout, /right.topic.concept/u);
    const miss = run("--resolve", "elsewhere", "--within", "docs/design/left");
    assert.equal(miss.status, 1);
    assert.match(miss.stderr, /not found.*docs\/design\/left/su);
    assert.doesNotMatch(miss.stderr, /does not exist in the repository/u);
  });
});

test("archived definition files are outside both aggregate and local discovery", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, "docs/design/archived/past.terms.yaml", definitionYaml("past.topic"));
    assert.equal(checkGlossary(root).terms, 1);
    assert.deepEqual(checkGlossary(root).errors, []);
    const local = queryTerms("共同概念", root, { within: "docs/design/archived" });
    assert.match(local.errors.join("\n"), /no registered sources/u);
    assert.deepEqual(local.matches, []);
  });
});

test("a term-use companion references canonical words without copying definitions", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, definitionYaml("left.topic"));
    write(root, RIGHT, 'version: 2\nterms: []\nreferences: ["shared concept"]\n');
    const report = checkGlossary(root);
    assert.deepEqual(report.errors, []);
    assert.equal(report.terms, 2);
    assert.equal(queryTerms("shared concept", root).matches.length, 1);
    assert.equal(queryTerms("shared concept", root).matches[0]?.source, LEFT);
  });
});

test("term references reject malformed, duplicate and unresolved words", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, wordDefinitionYaml("left.topic"));
    const prefix = "version: 2\nterms: []\nreferences: ";
    for (const [value, expected] of [
      ["not-an-array", /references must be an array/u],
      ["[12]", /term reference/u],
      ['[""]', /non-empty/u],
      ['[{term: "shared concept", namespace: "invalid namespace"}]', /namespace/u],
      ['[{term: "shared concept", extra: true}]', /unknown.*field/u],
      ['["shared concept", "SHARED CONCEPT"]', /duplicate term reference/u],
      [
        '["shared concept", {term: "shared concept", namespace: left.topic}]',
        /duplicate term reference/u,
      ],
      ['["missing concept"]', /not registered in the selected corpus/u],
      ["[共同概念]", /not registered in the selected corpus/u],
    ] as const) {
      write(root, RIGHT, prefix + value + "\n");
      assert.match(checkGlossary(root).errors.join("\n"), expected);
      assert.deepEqual(queryTerms("alpha", root).matches, []);
    }
  });
});

test("bounded term references do not load an outside definition implicitly", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, wordDefinitionYaml("left.topic"));
    write(root, RIGHT, 'version: 2\nterms: []\nreferences: ["shared concept"]\n');
    const local = queryTerms("shared concept", root, { within: "docs/design/right" });
    assert.deepEqual(local.sources, [RIGHT]);
    assert.deepEqual(local.matches, []);
    assert.match(local.errors.join("\n"), /not registered in the selected corpus/u);
    assert.equal(queryTerms("shared concept", root).matches.length, 1);
  });
});

test("canonical English words and translated aliases do not need artificial IDs", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, wordDefinitionYaml("left.topic"));
    assert.deepEqual(checkGlossary(root).errors, []);
    const canonical = queryTerms("shared concept", root).matches[0];
    assert.equal(canonical?.id, undefined);
    assert.equal(canonical?.namespace, "left.topic");
    assert.deepEqual(resolveTerm("共同概念", root), canonical);
  });
});

test("a unique word definition does not require a namespace declaration", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, wordDefinitionYaml("left.topic").replace("namespace: left.topic\n", ""));
    assert.deepEqual(checkGlossary(root).errors, []);
    const entry = resolveTerm("shared concept", root);
    assert.equal(entry?.namespace, "repository");
    assert.equal(entry?.id, undefined);
  });
});

test("only ambiguous canonical references require namespace qualification", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, wordDefinitionYaml("left.topic"));
    write(root, RIGHT, wordDefinitionYaml("right.topic"));
    const use = "docs/design/reader.terms.yaml";
    write(root, use, 'version: 2\nterms: []\nreferences: ["shared concept"]\n');
    assert.match(checkGlossary(root).errors.join("\n"), /ambiguous.*left.topic.*right.topic/u);
    assert.deepEqual(queryTerms("alpha", root).matches, []);
    write(
      root,
      use,
      'version: 2\nterms: []\nreferences: [{term: "shared concept", namespace: right.topic}]\n',
    );
    assert.deepEqual(checkGlossary(root).errors, []);
    assert.equal(checkGlossary(root).terms, 3);
    assert.equal(queryTerms("shared concept", root).matches.length, 2);
  });
});

test("canonical-word renames require reference migration while aliases preserve lookup", (t) => {
  withFixture(t, VALID, (root) => {
    write(
      root,
      LEFT,
      wordDefinitionYaml("left.topic", "new concept").replace(
        "aliases: [共同概念]",
        "aliases: [共同概念, old concept]",
      ),
    );
    write(root, RIGHT, 'version: 2\nterms: []\nreferences: ["old concept"]\n');
    assert.match(checkGlossary(root).errors.join("\n"), /not registered in the selected corpus/u);
    write(root, RIGHT, 'version: 2\nterms: []\nreferences: ["new concept"]\n');
    assert.deepEqual(checkGlossary(root).errors, []);
    assert.equal(resolveTerm("old concept", root)?.term, "new concept");
    assert.equal(resolveTerm("共同概念", root)?.term, "new concept");
  });
});

test("deprecated word definitions resolve a canonical successor in their namespace", (t) => {
  withFixture(t, VALID, (root) => {
    write(
      root,
      LEFT,
      wordDefinitionYaml("left.topic", "old concept").replace(
        "status: canonical",
        "status: deprecated\n    successor: new concept",
      ),
    );
    write(
      root,
      RIGHT,
      wordDefinitionYaml("right.topic", "new concept").replace(
        "aliases: [共同概念]",
        "aliases: []",
      ),
    );
    assert.match(checkGlossary(root).errors.join("\n"), /successor.*not a declared/u);
    write(
      root,
      RIGHT,
      wordDefinitionYaml("left.topic", "new concept").replace("aliases: [共同概念]", "aliases: []"),
    );
    assert.deepEqual(checkGlossary(root).errors, []);
  });
});

test("the word-key CLI keeps the TSV header and prints no invented ID", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, wordDefinitionYaml("left.topic"));
    const program = fileURLToPath(new URL("../../tools/glossary-check.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", program, "--resolve", "共同概念"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split("\n")[0], "shared concept\tdocs/owner.md\tAlpha");
    assert.match(result.stdout, /Namespace: left.topic/u);
    assert.match(result.stdout, /Definition: A definition maintained by this topic\./u);
    assert.doesNotMatch(result.stdout, /ID:/u);
  });
});

test("an explicit no-specialized-terms companion does not manufacture definitions", (t) => {
  withFixture(t, VALID, (root) => {
    write(root, LEFT, "version: 2\nnamespace: left.topic\nterms: []\nreferences: []\n");
    assert.deepEqual(checkGlossary(root).errors, []);
    assert.equal(checkGlossary(root).terms, 1);
    rmSync(join(root, "docs/glossary.yaml"));
    assert.match(checkGlossary(root).errors.join("\n"), /no registered definitions/u);
  });
});

test("definition contract targets are repository-relative and exclude fenced headings", (t) => {
  withFixture(t, VALID, (root) => {
    const valid = definitionYaml("left.topic");
    write(
      root,
      LEFT,
      valid.replace(
        "owner: docs/owner.md",
        `owner: ${join(root, "docs/owner.md").replaceAll("\\", "/")}`,
      ),
    );
    assert.match(checkGlossary(root).errors.join("\n"), /repository-relative/u);
    write(root, LEFT, valid);
    write(root, "docs/owner.md", "# Other\n\n```markdown\n# Alpha\n```\n");
    assert.match(checkGlossary(root).errors.join("\n"), /is not a heading/u);
  });
});
