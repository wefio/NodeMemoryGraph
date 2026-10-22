// Reproducible one-way generation for the SQLite callback trampolines.
//
//   callbacks.manifest.json (the only generation input)
//     → this generator
//     → callbacks.wasm + the loader's signature-keyed export-name map
//
// The manifest is the readable compatibility coverage set (382 signatures
// carried over from the v19 cloud service). It is NOT a measured list of
// what SQLite actually uses; shrinking it later means editing the manifest
// against SQLite's own signature declarations. Generation never reads the
// historical stub modules or their byte manifest; `--verify-legacy` is the
// one-time byte-consistency bridge against an extracted reference copy.
//
// Each manifest entry becomes: one merged-module type, one import
// (module "e", field = entry name), and one re-exporting export — so the
// wasm function pointer sqlite binds IS the host function.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sqliteWasmDir = fileURLToPath(new URL('../sqlite-wasm/', import.meta.url));
const manifest = JSON.parse(readFileSync(sqliteWasmDir + 'callbacks.manifest.json', 'utf8'));

const VALUE_TYPES = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
const leb = (value, out) => {
  let n = value;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
};
const section = (id, content) => { const out = [id]; leb(content.length, out); out.push(...content); return out; };
const wasmName = (text) => [...text].map((c) => c.charCodeAt(0));

// The runtime lookup key is the byte image of a standalone stub with this
// signature — the same construction the loader performs at install time.
// The type section is a vector: count byte first, then the functype.
function stubBytes({ params, result }) {
  const type = [0x60, params.length, ...params.map((p) => VALUE_TYPES[p])];
  if (result === 'void') type.push(0);
  else type.push(1, VALUE_TYPES[result]);
  const typeSection = [1, ...type];
  const body = [1, typeSection.length, ...typeSection, 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0];
  return [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...body];
}

const names = new Set();
for (const entry of manifest) {
  if (names.has(entry.name)) throw new Error(`duplicate manifest name ${entry.name}`);
  names.add(entry.name);
  for (const p of entry.params) if (!(p in VALUE_TYPES)) throw new Error(`${entry.name}: unknown param type ${p}`);
  if (entry.result !== 'void' && !(entry.result in VALUE_TYPES)) throw new Error(`${entry.name}: unknown result type ${entry.result}`);
}

const count = manifest.length;
const typeCount = [];
leb(count, typeCount);
const typeContent = [...typeCount];
const importContent = [];
leb(count, importContent);
const exportContent = [];
leb(count, exportContent);
const entries = manifest.map((entry, index) => {
  const type = [0x60, entry.params.length, ...entry.params.map((p) => VALUE_TYPES[p])];
  if (entry.result === 'void') type.push(0);
  else type.push(1, VALUE_TYPES[entry.result]);
  typeContent.push(...type);
  importContent.push(1, 101, ...lebLen(entry.name), ...wasmName(entry.name), 0);
  leb(index, importContent);
  exportContent.push(...lebLen(entry.name), ...wasmName(entry.name), 0);
  leb(index, exportContent);
  return { entry, key: stubBytes(entry).join(','), type };
});
function lebLen(text) { const out = []; leb(text.length, out); return out; }

const merged = new Uint8Array([
  ...[0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
  ...section(1, typeContent),
  ...section(2, importContent),
  ...section(7, exportContent),
]);

// Compile and forward-check every export: the re-exported import must reach
// the host function with the recorded arity and convert i64 in both
// directions; void signatures return undefined.
const module = new WebAssembly.Module(merged);
const calls = [];
const instance = new WebAssembly.Instance(module, {
  e: new Proxy({}, { get: (_, importName) => {
    const entry = manifest.find((candidate) => candidate.name === importName);
    if (!entry) throw new Error(`unexpected import ${String(importName)}`);
    const resultIsI64 = entry.result === 'i64';
    return (...args) => {
      calls.push([entry.name, args]);
      return resultIsI64 ? BigInt(args.length) : entry.result === 'void' ? undefined : args.length;
    };
  } }),
});
for (const { entry } of entries) {
  const args = entry.params.map((p, position) => (p === 'i64' ? BigInt(position + 1) : position + 1));
  const result = instance.exports[entry.name](...args);
  const expected = entry.result === 'void' ? undefined : entry.result === 'i64' ? BigInt(entry.params.length) : entry.params.length;
  if (result !== expected) {
    throw new Error(`export ${entry.name} did not forward (expected ${String(expected)}, got ${String(result)})`);
  }
}
if (calls.length !== count) throw new Error('not every export forwarded');

writeFileSync(sqliteWasmDir + 'callbacks.wasm', merged);

// Regenerate the loader's lookup table between builds so the committed
// loader can never drift from the manifest. The keys are pure functions of
// the manifest signatures, never of historical files.
let loader = readFileSync(sqliteWasmDir + 'worker-loader.mjs', 'utf8');
const staticImport = "import callbacksModule from './callbacks.wasm';";
if (!loader.includes(staticImport)) throw new Error('loader static import missing');
const registry = /^const callbackExports = new Map\(\[\[.*\]\]\);$/m;
if (!registry.test(loader)) throw new Error('loader callbackExports registry missing');
const table = entries.map(({ key, entry }) => `[${JSON.stringify(key)},${JSON.stringify(entry.name)}]`).join(',');
loader = loader.replace(registry, `const callbackExports = new Map([${table}]);`);
writeFileSync(sqliteWasmDir + 'worker-loader.mjs', loader);

console.log(`generated callbacks.wasm (${merged.length} bytes) for ${count} manifest signatures; all exports forward-checked; loader table regenerated.`);
