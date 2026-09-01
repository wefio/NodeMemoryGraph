import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileIndex,
  collectFiles,
  defaultExclude,
  parseScopeFile,
  resolveScopeEntries,
} from "../../src/core/file-index.ts";

function fixture(): { root: string; dataDir: string; scope: string } {
  const root = mkdtempSync(join(tmpdir(), "nmg-file-index-"));
  const dataDir = join(root, ".nmg");
  const scope = join(root, ".nmg-search-scope");
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, scope };
}

test("parseScopeFile: one path per line, # comments, blank lines ignored", () => {
  assert.deepEqual(
    parseScopeFile("# hot zones\nsrc/core/store/\n\ndocs/design/\n  src/cli  \n"),
    ["src/core/store", "docs/design", "src/cli"],
  );
  assert.deepEqual(parseScopeFile(""), []);
});

test("resolveScopeEntries: relative paths resolve under project root, dirs flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-scope-resolve-"));
  mkdirSync(join(root, "src", "core"), { recursive: true });
  writeFileSync(join(root, "README.md"), "x");
  const entries = resolveScopeEntries(root, ["src/core", "README.md", "missing"]);
  assert.deepEqual(
    entries.map((entry) => ({ path: entry.path, dir: entry.dir })),
    [
      { path: "src/core", dir: true },
      { path: "README.md", dir: false },
      { path: "missing", dir: false },
    ],
  );
  rmSync(root, { recursive: true, force: true });
});

test("collectFiles: walks directory entries, respects exclude and size cap", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-collect-"));
  mkdirSync(join(root, "src", "core"), { recursive: true });
  mkdirSync(join(root, "src", "node_modules"), { recursive: true });
  writeFileSync(join(root, "src", "core", "a.ts"), "a");
  writeFileSync(join(root, "src", "core", "b.md"), "b");
  writeFileSync(join(root, "src", "node_modules", "c.js"), "c");
  const files = collectFiles(root, { path: "src", dir: true }, 1024, defaultExclude);
  assert.deepEqual(files, ["src/core/a.ts", "src/core/b.md"]);
  rmSync(root, { recursive: true, force: true });
});

test("FileIndex: crawl indexes scope files, search finds them, incremental skips unchanged", () => {
  const { root, dataDir, scope } = fixture();
  writeFileSync(scope, "src/core\n", "utf8");
  mkdirSync(join(root, "src", "core"), { recursive: true });
  writeFileSync(join(root, "src", "core", "retrieval.ts"), "function searchMemory() {}");
  writeFileSync(join(root, "src", "core", "writes.ts"), "function remember() {}");

  const index = new FileIndex({ projectRoot: root, dataDir, scopePath: scope });
  try {
    const first = index.crawl();
    assert.equal(first.indexed, 2);

    const hits = index.search("searchMemory");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, "src/core/retrieval.ts");
    // Trigram snippet may truncate the match; require a partial token.
    assert.ok(/searc/u.test(hits[0]!.excerpt), "excerpt contains a fragment of the match");
    assert.ok(hits[0]!.score > 0, "bm25 negated: relevant hit has a positive score");

    // Second crawl with no changes: nothing re-indexed.
    const second = index.crawl();
    assert.equal(second.indexed, 0);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileIndex: changed file is re-indexed, removed file is dropped", () => {
  const { root, dataDir, scope } = fixture();
  writeFileSync(scope, "src\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "token-one");

  const index = new FileIndex({ projectRoot: root, dataDir, scopePath: scope });
  try {
    index.crawl();
    assert.equal(index.search("token-one").length, 1);

    // Change content → re-index picks up the new term.
    writeFileSync(join(root, "src", "a.ts"), "token-two");
    const changed = index.crawl();
    assert.equal(changed.indexed, 1);
    assert.equal(index.search("token-two").length, 1);
    assert.equal(index.search("token-one").length, 0);

    // Delete file → dropped from index.
    rmSync(join(root, "src", "a.ts"));
    const removed = index.crawl();
    assert.equal(removed.removed, 1);
    assert.equal(index.search("token-two").length, 0);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileIndex: addScopePath grows the scope with dedup and cap", () => {
  const { root, dataDir, scope } = fixture();
  writeFileSync(scope, "src/core\n", "utf8");
  const index = new FileIndex({ projectRoot: root, dataDir, scopePath: scope, maxScopePaths: 3 });
  try {
    index.addScopePath("docs/design/");
    index.addScopePath("src/cli");
    index.addScopePath("docs/design"); // dedup (trailing slash stripped)
    assert.deepEqual(index.readScope(), ["src/core", "docs/design", "src/cli"]);
    // Cap: adding a 4th drops the oldest.
    index.addScopePath("skills/");
    assert.deepEqual(index.readScope(), ["docs/design", "src/cli", "skills"]);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileIndex: defaultExclude skips VCS, node_modules, binaries, dot-dirs", () => {
  assert.equal(defaultExclude("node_modules/x.js"), true);
  assert.equal(defaultExclude("src/.git/config"), true);
  assert.equal(defaultExclude("src/a.png"), true);
  assert.equal(defaultExclude(".hidden/config.json"), true);
  assert.equal(defaultExclude(".nmg-search-scope"), false);
  assert.equal(defaultExclude("src/core/a.ts"), false);
});
