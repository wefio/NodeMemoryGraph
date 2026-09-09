import assert from "node:assert/strict";
import fs, {
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { compileContract } from "../../src/rcp/contract.ts";
import { planWorkOrder, readRouteDeclarations } from "../../src/rcp/planner.ts";
import {
  changedPaths,
  globMatches,
  observeRepository,
  isPathAllowed,
  normalizeRepositoryPath,
  scopeDirectoryReachable,
} from "../../src/rcp/repository.ts";
import { contractText, repositoryFixture } from "./fixture.ts";

const REFERENCE_SKIP_DIRECTORIES = new Set([".git", ".nmg", "node_modules"]);

function referenceFiles(root: string, scope: ReturnType<typeof contract>["scope"]) {
  const resolvedRoot = resolve(root);
  const files: Array<{ path: string; kind: "file" | "symlink"; digest: string }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isDirectory() && REFERENCE_SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const local = normalizeRepositoryPath(relative(resolvedRoot, absolute));
      if (local === ".rcp/receipts" || local.startsWith(".rcp/receipts/")) continue;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (isPathAllowed(local, scope)) {
        const value = stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute);
        files.push({
          path: local,
          kind: stat.isSymbolicLink() ? "symlink" : "file",
          digest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
        });
      }
    }
  };
  walk(resolvedRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function referenceRevision(
  contractValue: ReturnType<typeof contract>,
  files: ReturnType<typeof referenceFiles>,
): string {
  const hash = createHash("sha256");
  hash.update(contractValue.contractDigest);
  for (const file of files) hash.update(`\0${file.kind}:${file.path}:${file.digest}`);
  return `sha256:${hash.digest("hex")}`;
}

function contract() {
  const result = compileContract({ text: contractText(), path: "contract.yaml" });
  assert.ok(result.contract);
  return result.contract;
}

test("scope directory pruning stays safe for anchored and catch-all includes", () => {
  // src/rcp/** reaches src and src/rcp but not a sibling or deeper other root.
  const anchored = ["src/rcp/**"];
  assert.equal(scopeDirectoryReachable("src", anchored), true);
  assert.equal(scopeDirectoryReachable("src/rcp", anchored), true);
  assert.equal(scopeDirectoryReachable("src/lab", anchored), false);
  assert.equal(scopeDirectoryReachable("evals", anchored), false);
  assert.equal(scopeDirectoryReachable("", anchored), true); // root always traversed
  // A leading glob conservatively disables pruning; *.md does not cross directories.
  assert.equal(scopeDirectoryReachable("anywhere", ["**/guardrail.yaml"]), true);
  assert.equal(scopeDirectoryReachable("anywhere", ["*.md"]), true);
  // Bare root-level file reaches nothing below a subdirectory.
  assert.equal(scopeDirectoryReachable("docs", ["package.json"]), false);
  // Literal deep file reaches only its ancestor directories.
  assert.equal(scopeDirectoryReachable("docs", ["docs/design/a.md"]), true);
  assert.equal(scopeDirectoryReachable("docs/design", ["docs/design/a.md"]), true);
  assert.equal(scopeDirectoryReachable("docs/experiments", ["docs/design/a.md"]), false);
  // A single wildcard segment anchors at its literal prefix (safe over-approximation).
  assert.equal(scopeDirectoryReachable("src", ["src/*.ts"]), true);
  // Mixed includes use any reaching pattern.
  assert.equal(scopeDirectoryReachable("evals", ["src/**", "evals/controller/**"]), true);
});

test("wide scope reports a non-blocking soft size diagnostic instead of skipping", () => {
  const root = repositoryFixture();
  const compiled = compileContract({
    text: contractText().replace("include: [src/**]", "include: ['**']"),
    path: "contract.yaml",
  });
  assert.ok(compiled.contract);
  // A tiny soft bound forces the warning on this small fixture.
  const observation = observeRepository(root, compiled.contract, { softBytes: 4 });
  assert.ok(observation.observedBytes && observation.observedBytes > 4);
  assert.ok(observation.diagnostics.some((message) => message.includes("declared scope reaches")));
  // Non-blocking: allowed content is still fully observed (every fixture file).
  assert.deepEqual(observation.files.map((file) => file.path).sort(), [
    "agent-context.yaml",
    "docs/design.md",
    "outside.txt",
    "package.json",
    "src/value.ts",
  ]);
  // A generous soft bound adds no diagnostic.
  const quiet = observeRepository(root, compiled.contract);
  assert.equal(
    quiet.diagnostics.some((message) => message.includes("declared scope reaches")),
    false,
  );
});

test("pruning does not descend unreachable directories and matches a non-pruning reference", () => {
  const root = repositoryFixture();
  const unreachable = join(root, "unreachable", "deep", "data");
  mkdirSync(unreachable, { recursive: true });
  writeFileSync(join(unreachable, "large-fixture.txt"), "not in scope\n");
  const compiled = compileContract({
    text: contractText().replace("include: [src/**]", "include: [src/rcp/**]"),
    path: "contract.yaml",
  });
  assert.ok(compiled.contract);
  const reference = referenceFiles(root, compiled.contract.scope);
  const expectedRevision = referenceRevision(compiled.contract, reference);
  const originalReaddir = fs.readdirSync;
  let descended = false;
  fs.readdirSync = ((path: PathLike, options?: Parameters<typeof fs.readdirSync>[1]) => {
    if (resolve(String(path)) === resolve(join(root, "unreachable"))) descended = true;
    return Reflect.apply(originalReaddir, fs, [path, options]);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    const observation = observeRepository(root, compiled.contract);
    assert.deepEqual(observation.files, reference);
    assert.equal(observation.observedRevision, expectedRevision);
  } finally {
    fs.readdirSync = originalReaddir;
    syncBuiltinESMExports();
  }
  assert.equal(descended, false);
});

test("mixed include and exclude patterns preserve reference files and revision", () => {
  const root = repositoryFixture();
  mkdirSync(join(root, "src", "keep"), { recursive: true });
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  mkdirSync(join(root, "docs", "public"), { recursive: true });
  writeFileSync(join(root, "src", "keep", "value.ts"), "export const kept = true;\n");
  writeFileSync(join(root, "src", "generated", "value.ts"), "export const generated = true;\n");
  writeFileSync(join(root, "docs", "public", "guide.md"), "# Public\n");
  const compiled = compileContract({
    text: contractText()
      .replace("include: [src/**]", "include: [src/**, docs/**/*.md]")
      .replace("exclude: [src/generated/**]", "exclude: [src/generated/**, docs/private/**]"),
    path: "contract.yaml",
  });
  assert.ok(compiled.contract);
  const reference = referenceFiles(root, compiled.contract.scope);
  const observation = observeRepository(root, compiled.contract);
  assert.deepEqual(observation.files, reference);
  assert.equal(observation.observedRevision, referenceRevision(compiled.contract, reference));
  assert.deepEqual(
    observation.files.map((file) => file.path),
    ["docs/design.md", "docs/public/guide.md", "src/keep/value.ts", "src/value.ts"],
  );
});

test("custom glob matches keep every matching file ancestor reachable", () => {
  const cases = [
    {
      pattern: "packages/*/src/**/test-?.ts",
      file: "packages/app/src/unit/test-a.ts",
      unrelated: "vendor",
    },
    {
      pattern: "docs/?/readme.md",
      file: "docs/a/readme.md",
      unrelated: "other",
    },
  ];
  for (const { pattern, file, unrelated } of cases) {
    assert.equal(globMatches(pattern, file), true);
    const segments = file.split("/");
    for (let length = 1; length < segments.length; length++) {
      assert.equal(
        scopeDirectoryReachable(segments.slice(0, length).join("/"), [pattern]),
        true,
        `${pattern} must reach ${segments.slice(0, length).join("/")}`,
      );
    }
    assert.equal(scopeDirectoryReachable(unrelated, [pattern]), false);
  }
});

test("glob matching and observation stay within declared scope", () => {
  assert.equal(globMatches("src/**", "src/value.ts"), true);
  assert.equal(globMatches("src/*.ts", "src/nested/value.ts"), false);
  const root = repositoryFixture();
  const observation = observeRepository(root, contract());
  assert.deepEqual(
    observation.files.map((file) => file.path),
    ["src/value.ts"],
  );
  assert.equal(observation.git.available, true);
  assert.equal(observation.git.dirtyFiles.length, 0);
});

test("observed revision changes with scoped content and reports exact changed paths", () => {
  const root = repositoryFixture();
  const before = observeRepository(root, contract());
  writeFileSync(join(root, "src", "value.ts"), "export const value = 2;\n");
  const after = observeRepository(root, contract());
  assert.notEqual(after.observedRevision, before.observedRevision);
  assert.deepEqual(changedPaths(before, after), ["src/value.ts"]);
});

// Negative control: the edit-only case above has a single changed path, so it
// cannot pin ordering. Dropping the sort fails here and nowhere else; a mutant
// that reports only additions or only removals fails here too.
test("changed paths are sorted and include removals", () => {
  const root = repositoryFixture();
  const before = observeRepository(root, contract());
  rmSync(join(root, "src", "value.ts"));
  writeFileSync(join(root, "src", "added.ts"), "export const added = true;\n");
  const after = observeRepository(root, contract());
  assert.deepEqual(changedPaths(before, after), ["src/added.ts", "src/value.ts"]);
});

test("receipt output never changes a broad repository observation", () => {
  const root = repositoryFixture();
  const compiled = compileContract({
    text: contractText().replace("include: [src/**]", "include: ['**']"),
    path: "contract.yaml",
  });
  assert.ok(compiled.contract);
  const before = observeRepository(root, compiled.contract);
  mkdirSync(join(root, ".rcp", "receipts"), { recursive: true });
  writeFileSync(join(root, ".rcp", "receipts", "result.json"), "{}\n");
  const after = observeRepository(root, compiled.contract);
  assert.equal(after.observedRevision, before.observedRevision);
  assert.equal(
    after.files.some((file) => file.path.startsWith(".rcp/receipts/")),
    false,
  );
});

test("planner maps Contract scope to repository routes and a bounded WorkOrder", () => {
  const root = repositoryFixture();
  const value = contract();
  const observation = observeRepository(root, value);
  const order = planWorkOrder({
    contract: value,
    observation,
    routes: readRouteDeclarations(root),
  });
  assert.equal(order.contractDigest, value.contractDigest);
  assert.deepEqual(order.routes, ["source"]);
  assert.deepEqual(order.owners, ["docs/design.md"]);
  assert.deepEqual(order.verificationChecks, ["check"]);
  assert.deepEqual(order.allowedPaths, ["src/**"]);
  assert.deepEqual(order.budget, { maxAttempts: 1, timeoutMs: 30 * 60 * 1_000 });
});
