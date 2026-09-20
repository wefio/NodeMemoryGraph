/**
 * The layer rule, checked instead of remembered: the harness file is an adapter, so a name the
 * shared mechanism owns may not be imported from it.
 *
 * Nothing else catches this. `evals/**` has no tsconfig coverage, so `tsc --noEmit` never reads the
 * drivers, and lint does not know which module owns which name. It did break: after the mechanism
 * moved to the shared layer, a live fused run failed with "patchSessionInput is not a function",
 * because plan-driver.ts still asked the adapter for a name the adapter no longer owns.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SHARED = "src/integration/ooo-session-mechanism.ts";
const ADAPTER = "nmg/ooo-execution.ts";
const ROOTS = ["evals", "tests", ".pi", "src"];

function typescriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...typescriptFiles(path));
    else if (entry.endsWith(".ts")) found.push(path.split("\\").join("/"));
  }
  return found;
}

/** The names the shared module exports, which are the names the adapter may not hand out. */
function sharedNames(): string[] {
  return readFileSync(SHARED, "utf8")
    .split(/\r?\n/)
    .map(
      (line) =>
        /^export (?:async )?(?:declare )?(?:interface|type|function|const|let|class|enum)\s+([A-Za-z_$][\w$]*)/.exec(
          line,
        )?.[1],
    )
    .filter((name): name is string => Boolean(name));
}

/**
 * The names one file takes from the adapter, in both forms a driver uses. The dynamic form matters:
 * a driver that awaits an import and destructures it is exactly how the breakage above happened, and
 * a check that only reads static imports passes while the run fails.
 */
function namesTakenFromAdapter(text: string): string[] {
  const names: string[] = [];
  const patterns = [
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]*)"/g,
    /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s*)?import\(\s*"([^"]*)"\s*\)/g,
    /import\(\s*"([^"]*)"\s*\)\.([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    const isTypeForm = pattern === patterns[2];
    for (const match of text.matchAll(pattern)) {
      const path = isTypeForm ? match[1] : match[2];
      if (!path!.includes(ADAPTER)) continue;
      if (isTypeForm) {
        names.push(match[2]!);
        continue;
      }
      for (const part of match[1]!.split(",")) {
        const name = part
          .replace(/\btype\b/, "")
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name) names.push(name);
      }
    }
  }
  return names;
}

test("no file asks the adapter for a name the shared mechanism owns", () => {
  const shared = sharedNames();
  // A guard that reads an empty list would pass for the wrong reason.
  assert.ok(shared.length > 20, `the shared module exports only ${shared.length} names`);
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of typescriptFiles(root)) {
      if (file === SHARED || file === `.pi/extensions/${ADAPTER}`) continue;
      const taken = namesTakenFromAdapter(readFileSync(file, "utf8"));
      for (const name of taken) {
        if (shared.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these imports must come from src/integration/ooo-session-mechanism.ts instead",
  );
});
