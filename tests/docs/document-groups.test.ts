import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { verifyDocumentGroups } from "../../scripts/verify-document-groups.ts";

const suffixes = [".md", ".zh-CN.md", ".terms.yaml"] as const;
const scratch =
  "docs/experiments/execution/archive/ooo-arms-2026-09-19/speculation-earm/run2-2026-09-19T05-40-04-311Z/CLEANABLE-scratch-2026-09-19";

function write(root: string, path: string, text = "# Content\n\nText.\n"): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function group(root: string, stem: string): void {
  for (const suffix of suffixes) write(root, stem + suffix);
}

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-document-groups-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  group(root, "README");
  return root;
}

test("new nested designs, Skill references and retained archives inherit group checks", (t) => {
  const root = fixture(t);
  for (const stem of [
    "docs/design/new-topic/contract",
    "skills/new-skill/references/recovery",
    "docs/design/archived/history",
    "docs/experiments/archive/retained-2026-10-18",
  ]) {
    group(root, stem);
  }
  assert.deepEqual(verifyDocumentGroups(root), { groups: 5, disposable: 0, errors: [] });
});

for (const suffix of suffixes) {
  test(`removing ${suffix} from a document group fails`, (t) => {
    const root = fixture(t);
    const stem = "docs/design/new-topic/contract";
    group(root, stem);
    rmSync(join(root, stem + suffix));
    assert.deepEqual(verifyDocumentGroups(root).errors, [
      `${stem}: missing regular file ${stem + suffix}`,
    ]);
  });
}

test("an entirely new single-language topic is not grandfathered", (t) => {
  const root = fixture(t);
  write(root, "skills/new-skill/references/usage.md");
  const report = verifyDocumentGroups(root);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.some((error) => error.includes("usage.zh-CN.md")));
  assert.ok(report.errors.some((error) => error.includes("usage.terms.yaml")));
});

test("a lone terms file cannot disappear from discovery with both prose files", (t) => {
  const root = fixture(t);
  write(root, "docs/design/orphan.terms.yaml");
  const report = verifyDocumentGroups(root);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.some((error) => error.endsWith("orphan.md")));
  assert.ok(report.errors.some((error) => error.endsWith("orphan.zh-CN.md")));
});

test("a lone Chinese counterpart is also an incomplete group", (t) => {
  const root = fixture(t);
  write(root, "docs/design/orphan.zh-CN.md");
  const report = verifyDocumentGroups(root);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.some((error) => error.endsWith("orphan.md")));
  assert.ok(report.errors.some((error) => error.endsWith("orphan.terms.yaml")));
});

test("directories cannot stand in for companion files", (t) => {
  const root = fixture(t);
  write(root, "docs/design/topic.md");
  write(root, "docs/design/topic.zh-CN.md");
  mkdirSync(join(root, "docs/design/topic.terms.yaml"));
  assert.deepEqual(verifyDocumentGroups(root).errors, [
    "docs/design/topic: missing regular file docs/design/topic.terms.yaml",
  ]);
});

test("discovery does not follow symlinked directories outside the corpus", (t) => {
  const root = fixture(t);
  write(root, "outside/unpaired.md");
  mkdirSync(join(root, "docs"));
  symlinkSync(join(root, "outside"), join(root, "docs/linked"), "junction");
  assert.deepEqual(verifyDocumentGroups(root), { groups: 1, disposable: 0, errors: [] });
});

test("a symbolic group member does not satisfy the regular-file requirement", (t) => {
  const root = fixture(t);
  group(root, "docs/design/topic");
  rmSync(join(root, "docs/design/topic.terms.yaml"));
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(root, "docs/design/topic.terms.yaml"), "junction");
  assert.ok(verifyDocumentGroups(root).errors.some((error) => error.endsWith("topic.terms.yaml")));
});

test("only the declared scratch with its cleanup condition can remain single-language", (t) => {
  const root = fixture(t);
  write(root, scratch + ".md", "It may be deleted once a record quotes its numbers.\n");
  assert.deepEqual(verifyDocumentGroups(root), { groups: 1, disposable: 1, errors: [] });
  write(root, "docs/experiments/CLEANABLE-another.md", "Same proposed cleanup condition.\n");
  assert.equal(verifyDocumentGroups(root).errors.length, 2);
  rmSync(join(root, scratch + ".md"));
  write(root, scratch + ".md", "Retained without a cleanup condition.\n");
  assert.equal(verifyDocumentGroups(root).disposable, 0);
  assert.equal(verifyDocumentGroups(root).errors.length, 4);
});

test("scratch companions re-enter ordinary completeness checking", (t) => {
  const root = fixture(t);
  write(root, scratch + ".md", "It may be deleted once a record quotes its numbers.\n");
  write(root, scratch + ".terms.yaml");
  assert.equal(verifyDocumentGroups(root).disposable, 0);
  assert.ok(
    verifyDocumentGroups(root).errors.some((error) => error.endsWith(scratch + ".zh-CN.md")),
  );
});

test("an empty corpus fails rather than reporting zero groups as success", (t) => {
  const root = fixture(t);
  for (const suffix of suffixes) rmSync(join(root, "README" + suffix));
  assert.equal(verifyDocumentGroups(root).errors.length, 3);
});

test("unadmitted directories do not silently acquire this check", (t) => {
  const root = fixture(t);
  write(root, "dsh/README.md");
  write(root, "evals/results/unpaired.md");
  assert.deepEqual(verifyDocumentGroups(root).errors, []);
});

test("the real CLI exits nonzero for a missing companion and zero after repair", (t) => {
  const root = fixture(t);
  const script = fileURLToPath(new URL("../../scripts/verify-document-groups.ts", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () =>
    spawnSync(process.execPath, ["--experimental-strip-types", script], {
      cwd: root,
      env,
      encoding: "utf8",
    });
  rmSync(join(root, "README.terms.yaml"));
  const rejected = run();
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /README\.terms\.yaml/);
  write(root, "README.terms.yaml");
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /document groups: 1 groups, 0 errors/);
});

test("the actual docs:check composition rejects a lost companion after structural checks pass", (t) => {
  const root = fixture(t);
  for (const stem of [
    "docs/README",
    "docs/decisions/README",
    "docs/postmortem/README",
    "docs/design/documentation-governance",
    "docs/design/ooo-execution-bootstrap",
    "skills/doc-maintenance/references/reader-review",
  ]) {
    group(root, stem);
  }
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const command = manifest.scripts["docs:check"];
  assert.ok(typeof command === "string");
  // A junction alias changes argv[1] without changing import.meta.url, bypassing CLI guards.
  // Rebase only script paths; preserve the package-owned command composition.
  const runnable = command.replace(/\bscripts\/[^\s&]+/g, (path) => {
    const file = fileURLToPath(new URL("../../" + path, import.meta.url));
    return `"${file.replaceAll("\\", "/")}"`;
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(runnable, { cwd: root, env, encoding: "utf8", shell: true });
  rmSync(join(root, "README.terms.yaml"));
  const rejected = run();
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stdout, /docs: .*0 errors/, rejected.stderr);
  assert.match(rejected.stderr, /README\.terms\.yaml/);
  write(root, "README.terms.yaml");
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /document groups: 7 groups, 0 errors/);
});
