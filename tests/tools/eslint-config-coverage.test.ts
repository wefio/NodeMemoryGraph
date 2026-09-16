import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

// The lint surface is decided by two files that never see each other: the `lint`
// script in package.json says which directories ESLint walks, and eslint.config.js
// decides which of those directories each `files:` block applies to. When they
// disagree the block does not fail — it silently applies to nothing. That is how
// the no-console exemption for tests/research/scripts sat inert while evals/ and
// scripts/ were never scanned at all (decision
// docs/decisions/implemented/2026-09-16-ci-static-coverage.md).
//
// The config is imported rather than pattern-matched from its text, and the last
// test asks ESLint itself for the effective config, so comments and formatting
// cannot decide the result.

const rootUrl = new URL("../../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);

const packageJson = JSON.parse(readFileSync(new URL("package.json", rootUrl), "utf8")) as {
  scripts: Record<string, string>;
};

interface FlatConfigEntry {
  readonly files?: string | readonly string[];
}

const config = (await import(new URL("eslint.config.js", rootUrl).href)) as {
  default: readonly FlatConfigEntry[];
};

/** Directory arguments of an ESLint script, e.g. `["src/", "tests/"]`. */
function lintedRoots(script: string): string[] {
  const args = script.split(/\s+/u).filter((token) => token.length > 0 && !token.startsWith("-"));
  assert.equal(args[0], "eslint", `${script} does not start with eslint`);
  const roots = args.slice(1);
  for (const root of roots) {
    assert.ok(
      root.endsWith("/"),
      `lint argument "${root}" is not written as a directory (add a trailing slash) — the guard cannot tell which surface it names`,
    );
  }
  return roots;
}

/**
 * The literal directories a `files:` pattern is anchored to, normalized as a
 * repository-relative prefix, or `undefined` when the pattern starts at a glob
 * (`**\/*.ts` applies wherever ESLint is invoked, so it makes no claim about the
 * lint script and there is nothing to disagree with).
 */
function anchoredDirectory(pattern: string): string | undefined {
  const match = /^((?:[^*?{}[\]]+\/)+)/u.exec(pattern);
  return match?.[1];
}

function filesBlockPatterns(): string[] {
  const patterns: string[] = [];
  for (const entry of config.default) {
    if (!entry?.files) continue;
    const files = Array.isArray(entry.files) ? entry.files : [entry.files as string];
    patterns.push(...files);
  }
  return patterns;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Flat-config glob (`**`, `*`, `{a,b}`) to a whole-path regular expression. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:[^/]+/)*";
      } else {
        source += "(?:[^/]+/)*[^/]*";
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map((alternative) => escapeRegExp(alternative.trim()));
        source += `(?:${alternatives.join("|")})`;
        index = end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, "u");
}

/** Repository-relative paths under a linted root, `/`-separated. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(new URL(relative, rootUrl), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        visit(`${relative}${entry.name}/`);
        continue;
      }
      if (entry.isFile()) found.push(`${relative}${entry.name}`);
    }
  };
  visit(root);
  return found;
}

test("lint and lint:fix scan the same surface", () => {
  const lint = lintedRoots(packageJson.scripts["lint"]!);
  const lintFix = lintedRoots(packageJson.scripts["lint:fix"]!);
  assert.ok(lint.length > 0, "the lint script names no directory");
  assert.deepEqual(lintFix, lint, "lint:fix and lint must scan the same directories");
});

test("every anchored eslint files: block is inside the lint script surface", () => {
  const roots = lintedRoots(packageJson.scripts["lint"]!);
  const patterns = filesBlockPatterns();
  assert.ok(patterns.length > 0, "eslint.config.js declares no files: block");
  assert.ok(
    patterns.some((pattern) => anchoredDirectory(pattern) !== undefined),
    "eslint.config.js declares no directory-anchored files: block to check",
  );
  for (const pattern of patterns) {
    const directory = anchoredDirectory(pattern);
    if (directory === undefined) continue;
    assert.ok(
      roots.includes(directory) || roots.some((root) => directory.startsWith(root)),
      `eslint.config.js files: "${pattern}" is anchored at ${directory}, which the lint script does not scan (${roots.join(
        " ",
      )}); ESLint never reaches those files, so the block applies to nothing`,
    );
  }
});

test("every anchored eslint files: block matches a file the lint script scans", () => {
  const roots = lintedRoots(packageJson.scripts["lint"]!);
  const scanned = roots.flatMap((root) => filesUnder(root));
  assert.ok(scanned.length > 0, "the lint script surface contains no files");
  for (const pattern of filesBlockPatterns()) {
    const directory = anchoredDirectory(pattern);
    if (directory === undefined) continue;
    if (!roots.includes(directory) && !roots.some((root) => directory.startsWith(root))) continue;
    const matches = globToRegExp(pattern);
    assert.ok(
      scanned.some((file) => matches.test(file)),
      `eslint.config.js files: "${pattern}" matches no file under ${roots.join(
        " ",
      )}; a block that matches nothing is dead config, not an exemption`,
    );
  }
});

test("the exemptions the config declares are the ones ESLint applies", async () => {
  const eslint = new ESLint({ cwd: rootPath });
  const severityOf = async (file: string, rule: string): Promise<number | undefined> => {
    const resolved = await eslint.calculateConfigForFile(file);
    const entry = resolved.rules?.[rule];
    if (entry === undefined) return undefined;
    return Array.isArray(entry) ? (entry[0] as number) : (entry as number);
  };

  // A repo script prints by design; product code warns on it.
  assert.equal(await severityOf("tests/cli/process.test.ts", "no-console"), 0);
  assert.equal(await severityOf("src/core/store.ts", "no-console"), 1);

  // Liveness rules report on the developer surfaces and still fail product code.
  for (const file of [
    "tests/tools/test-groups.test.ts",
    "evals/retrieval/run.ts",
    "scripts/verify-docs.mts",
  ]) {
    assert.equal(await severityOf(file, "@typescript-eslint/no-unused-vars"), 1, file);
    assert.equal(await severityOf(file, "no-useless-assignment"), 1, file);
  }
  assert.equal(await severityOf("src/core/store.ts", "@typescript-eslint/no-unused-vars"), 2);
  assert.equal(await severityOf("src/core/store.ts", "no-useless-assignment"), 2);
});
