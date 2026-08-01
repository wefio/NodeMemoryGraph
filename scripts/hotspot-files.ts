/**
 * File-hotspot analysis for the store cluster split.
 *
 * Static, source-only scan (no DB, no runtime): for every method defined in
 * the store modules (base + the four clusters), count how many *call sites*
 * reference it across the whole codebase (src, tests, evals, extensions),
 * both as `this.<method>(...)` internal calls and as `<store>.<method>(...)`
 * external calls. Prints the hot files and their hottest methods.
 *
 * This is the analysis that motivated the split (retrieval was the hot
 * cluster); re-run it after changes to see if hotspots have moved.
 *
 * Usage:
 *   node --experimental-strip-types scripts/hotspot-files.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Files/dirs skipped when scanning for call sites. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".nmg",
  ".benchmarks",
  "build",
]);

/** Store modules: name → path (relative to src/core). */
const STORE_MODULES: Record<string, string> = {
  base: "store/base.ts",
  graph: "store/graph.ts",
  retrieval: "store/retrieval.ts",
  writes: "store/writes.ts",
  maintenance: "store/maintenance.ts",
};

const ROOT = resolve(".");
const SRC_CORE = join(ROOT, "src", "core");

function tsFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

// ── gather defined methods per module ──
const moduleMethods = new Map<string, string[]>(); // module -> method names
for (const [name, rel] of Object.entries(STORE_MODULES)) {
  const text = readFileSync(join(SRC_CORE, rel), "utf8");
  // class members (2-space indent in base) and mixin members (4-space in clusters)
  const methods: string[] = [];
  for (const m of text.matchAll(/^ {2,4}(?!declare\b)(?:protected\s+)?([a-zA-Z_]\w*)\s*\(/gm)) {
    if (!["constructor", "close"].includes(m[1]!)) methods.push(m[1]!);
  }
  moduleMethods.set(name, [...new Set(methods)]);
}

// ── scan call sites across the repo ──
// counts: method -> { total, internal (this.x()), external }
const methodToModule = new Map<string, string>();
for (const [mod, methods] of moduleMethods) {
  for (const m of methods) methodToModule.set(m, mod);
}

const callCounts = new Map<string, { total: number; internal: number; external: number }>();
const moduleHits = new Map<string, { internal: number; external: number }>();
for (const mod of Object.keys(STORE_MODULES)) moduleHits.set(mod, { internal: 0, external: 0 });

const fileCount: Record<string, number> = { src: 0, tests: 0, evals: 0, extensions: 0 };
const scanned: string[] = [];

for (const dir of ["src", "tests", "evals"]) {
  if (!existsSync(join(ROOT, dir))) continue;
  for (const file of tsFiles(join(ROOT, dir))) {
    scanned.push(file);
    const text = readFileSync(file, "utf8");
    const baseKey = dir;
    // this.<method>( / this.<method>.  — a `.` or `(` follows the member
    for (const m of text.matchAll(/(?:this|store)\.([a-zA-Z_]\w*)\s*[.(]/g)) {
      const name = m[1]!;
      const mod = methodToModule.get(name);
      if (!mod) continue;
      const kind = m[0].startsWith("this.") ? "internal" : "external";
      const c = callCounts.get(name) ?? { total: 0, internal: 0, external: 0 };
      c.total++;
      if (kind === "internal") c.internal++;
      else c.external++;
      callCounts.set(name, c);
      const mh = moduleHits.get(mod)!;
      if (kind === "internal") mh.internal++;
      else mh.external++;
      fileCount[baseKey] = (fileCount[baseKey] ?? 0) + 1;
    }
  }
}

// ── report: module-first (which modules are the hot ones) ──
console.log(`\nscanned ${scanned.length} files across src/tests/evals\n`);
console.log("== modules by call-site volume (hot modules first) ==");
const modRows = [...moduleHits.entries()]
  .map(([mod, h]) => ({
    mod,
    ...h,
    total: h.internal + h.external,
    methods: moduleMethods.get(mod)!.length,
  }))
  .sort((a, b) => b.total - a.total);
const grandTotal = modRows.reduce((a, r) => a + r.total, 0);
for (const r of modRows) {
  const share = ((r.total / grandTotal) * 100).toFixed(1);
  const perMethod = r.total / r.methods;
  console.log(
    `  ${r.mod.padEnd(12)} calls=${String(r.total).padStart(4)}  share=${String(share).padStart(5)}%  ` +
      `methods=${String(r.methods).padStart(3)}  calls/method=${perMethod.toFixed(1).padStart(5)}  ` +
      `(internal ${r.internal}, external ${r.external})`,
  );
}

console.log("\n== hot methods per module (module's top contributors) ==");
// methods grouped by module, sorted by total desc, top 5 per module
const byModule = new Map<
  string,
  { name: string; c: { total: number; internal: number; external: number } }[]
>();
for (const [name, c] of callCounts) {
  const mod = methodToModule.get(name)!;
  const arr = byModule.get(mod) ?? [];
  arr.push({ name, c });
  byModule.set(mod, arr);
}
for (const [mod, methods] of [...byModule.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const totalMod = moduleHits.get(mod)!.internal + moduleHits.get(mod)!.external;
  const top = methods.sort((a, b) => b.c.total - a.c.total).slice(0, 5);
  console.log(`\n  ${mod}:`);
  for (const { name, c } of top) {
    const pct = totalMod ? ((c.total / totalMod) * 100).toFixed(0) : "0";
    console.log(
      `    ${name.padEnd(28)} calls=${String(c.total).padStart(4)}  (${String(pct).padStart(2)}% of module)  ` +
        `internal=${c.internal} external=${c.external}`,
    );
  }
}

console.log("\n== call-site volume by area ==");
for (const [area, n] of Object.entries(fileCount)) console.log(`  ${area}: ${n}`);
