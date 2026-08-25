import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/**
 * Generic module-boundary guard.
 *
 * When a group of symbols moves out of one module into another (e.g. the
 * row mappers moving from store.ts into store/rows.ts), this guard pins
 * the new boundary with four checks:
 *
 *   1. every extracted symbol is DEFINED in the new module,
 *   2. it is no longer DEFINED in the old module,
 *   3. the old module does not RE-EXPORT it — a backdoor that would let
 *      stale imports keep compiling,
 *   4. no file in the repository imports it from the old module path
 *      (the import graph is scanned as plain text).
 *
 * It also asserts the `kept` anchors still exist in the old module, so the
 * guard catches a move going too far as well as a move not going far
 * enough.
 *
 * Generic by design: when the next group moves out (e.g. method clusters
 * into store/xxx.ts), add one entry to EXTRACTED — nothing else changes.
 * Source is read as text (no compiler, no program), so the whole scan runs
 * in a few milliseconds and is safe for every `npm test`.
 */

type ExtractedGroup = {
  /** File that USED to define the symbols (the monolith). */
  sourceFile: string;
  /** File they moved to. */
  moduleFile: string;
  /** Symbols that must exist only in moduleFile. */
  symbols: readonly string[];
  /** Symbols that must still be defined in sourceFile. */
  kept: readonly string[];
};

const EXTRACTED: ExtractedGroup[] = [
  {
    sourceFile: "src/core/store.ts",
    moduleFile: "src/core/store/rows.ts",
    symbols: [
      "mapNode",
      "canonicalNodeIdentity",
      "mapLeafBlock",
      "mapTopologyProposal",
      "partitionLabel",
      "leafBlockSummary",
      "stableLeafBlockId",
      "mapSearchResult",
      "mapHistory",
      "mapRelation",
      "mapConsolidationEvent",
      "mapMemoryWriteEvent",
      "mapActivation",
      "identityTokens",
      "requireText",
      "clamp",
      "defaultResidence",
      "defaultWriteReason",
      "parseScope",
      "parseStoredJson",
      "parseQppDecision",
      "StoredClaim",
      "serializeClaims",
      "parseClaims",
      "normalizeMarkers",
      "serializeMarkers",
      "parseMarkers",
      "matchesScope",
      "effectiveFilterDimensions",
    ],
    kept: ["NmgStore"],
  },
  {
    sourceFile: "src/core/store/rows.ts",
    moduleFile: "src/core/scope.ts",
    symbols: ["serializeScope"],
    kept: ["mapNode"],
  },
];

/** Directories scanned for stale imports (skip vendored/build output). */
const SCAN_DIRS = ["src", "tests", "evals", "claude-plugins", ".pi"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".nmg", "build"]);

function tsFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...tsFiles(full));
    else if (/\.(ts|mts|cts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

function moduleKey(path: string): string {
  return resolve(path)
    .replace(/\.[cm]?tsx?$/, "")
    .toLowerCase();
}

/** `import [type] { a, b as c } from "<specifier>"` — multiline-safe. */
const IMPORT_RE = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g;

/** Symbols a file exports via an explicit `export { ... }` list. */
function reExportedNames(source: string): string[] {
  const names: string[] = [];
  const listRe = /export\s*\{([\s\S]*?)\}\s*(?:from\s*['"][^'"]+['"])?\s*;/g;
  for (const match of source.matchAll(listRe)) {
    for (const part of match[1]!.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

test("module boundary: extracted symbols live only in their new module", () => {
  for (const group of EXTRACTED) {
    const sourceText = readFileSync(group.sourceFile, "utf8");
    const moduleText = readFileSync(group.moduleFile, "utf8");

    // 1. defined in the new module.
    for (const symbol of group.symbols) {
      assert.match(
        moduleText,
        new RegExp(
          `^export\\s+(?:async\\s+)?(?:function|const|type|class|interface|enum)\\s+${symbol}\\b`,
          "m",
        ),
        `${symbol} must be defined (exported) in ${group.moduleFile}`,
      );
    }
    // 2. no longer defined in the old module.
    for (const symbol of group.symbols) {
      assert.doesNotMatch(
        sourceText,
        new RegExp(
          `^(?:export\\s+)?(?:async\\s+)?(?:function|const|type|class|interface|enum)\\s+${symbol}\\b`,
          "m",
        ),
        `${symbol} must no longer be defined in ${group.sourceFile}`,
      );
    }
    // 3. the old module must not re-export them (stale-import backdoor).
    const leaked = group.symbols.filter((symbol) => reExportedNames(sourceText).includes(symbol));
    assert.deepEqual(leaked, [], `${group.sourceFile} must not re-export extracted symbols`);
    assert.doesNotMatch(
      sourceText,
      /export\s*\*\s*from/,
      `${group.sourceFile} must not re-export via export *`,
    );
    // The anchors must have stayed behind.
    for (const symbol of group.kept) {
      assert.match(
        sourceText,
        new RegExp(
          `^(?:export\\s+)?(?:async\\s+)?(?:function|const|type|class|interface|enum)\\s+${symbol}\\b`,
          "m",
        ),
        `${symbol} must still be defined in ${group.sourceFile}`,
      );
    }
  }
});

test("module boundary: no file imports extracted symbols from the old module path", () => {
  const sourceKey = moduleKey(EXTRACTED[0]!.sourceFile);
  const offenders: string[] = [];
  for (const directory of SCAN_DIRS) {
    for (const file of tsFiles(directory)) {
      const key = moduleKey(file);
      if (key === sourceKey || key === moduleKey(EXTRACTED[0]!.moduleFile)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = match[2]!;
        if (!specifier.startsWith(".")) continue;
        if (moduleKey(join(dirname(file), specifier)) !== sourceKey) continue;
        const extracted = EXTRACTED[0]!.symbols.filter((symbol) =>
          match[1]!.split(",").some(
            (part) =>
              part
                .trim()
                .split(/\s+as\s+/)[0]!
                .trim() === symbol,
          ),
        );
        if (extracted.length > 0) {
          offenders.push(
            `${file}: imports ${extracted.join(", ")} from ${EXTRACTED[0]!.sourceFile}`,
          );
        }
      }
    }
  }
  assert.deepEqual(offenders, [], "extracted symbols must be imported from the new module path");
});
