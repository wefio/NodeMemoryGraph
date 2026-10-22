// One-time vendor transform: merge the 382 per-signature callback stub modules
// (callback-0.wasm … callback-381.wasm) into one multi-export WebAssembly
// module. Each original stub is a 35-40 byte module that imports e.f and
// re-exports it under one fixed signature; the merged module imports
// e.cb0…e.cb381 (same signatures) and re-exports them as f0…f381.
// Regenerate only from the original stub set (legacy transfer or upstream).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vendor = fileURLToPath(new URL('../vendor/sqlite-wasm/', import.meta.url));
const list = JSON.parse(readFileSync(vendor + 'callback-list.json', 'utf8'));
const leb = (value, out) => {
  let n = value;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
};
const section = (id, content) => { const out = [id]; leb(content.length, out); out.push(...content); return out; };

// Parse each stub's single type entry: [count=1, 0x60, params…, results…].
const typeEntries = [];
const exportNames = [];
for (const { key, name } of list) {
  const stub = readFileSync(vendor + name);
  const bytes = [...stub];
  if (bytes.slice(0, 8).join(',') !== key.split(',').slice(0, 8).join(',')) {
    throw new Error(`${name}: header does not match its recorded key`);
  }
  if (bytes[8] !== 1) throw new Error(`${name}: expected type section first`);
  const typeSize = bytes[9];
  const content = bytes.slice(10, 10 + typeSize);
  if (content[0] !== 1) throw new Error(`${name}: expected exactly one type`);
  if (bytes[10 + typeSize] !== 2) throw new Error(`${name}: expected import section second`);
  if (bytes.slice(10 + typeSize, 10 + typeSize + 9).join(',') !== '2,7,1,1,101,1,102,0,0') {
    throw new Error(`${name}: unexpected import section`);
  }
  typeEntries.push(content.slice(1));
  exportNames.push('f' + exportNames.length);
}

const count = typeEntries.length;
const typeCount = [];
leb(count, typeCount);
const typeContent = [...typeCount, ...typeEntries.flat()];
// Import and export sections are vectors too: count prefix, then entries.
const importContent = [];
leb(count, importContent);
typeEntries.forEach((_, index) => {
  const field = 'cb' + index;
  importContent.push(1, 101, field.length, ...[...field].map((c) => c.charCodeAt(0)), 0);
  leb(index, importContent);
});
const exportContent = [];
leb(count, exportContent);
exportNames.forEach((name, index) => {
  exportContent.push(name.length, ...[...name].map((c) => c.charCodeAt(0)), 0);
  leb(index, exportContent);
});

const merged = new Uint8Array([
  ...[0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
  ...section(1, typeContent),
  ...section(2, importContent),
  ...section(7, exportContent),
]);

// 1:1 comparison against the source stubs: walk the merged type section and
// require every entry to equal its stub's type entry, then compile and
// forward-check all exports through their recorded arities.
const module = new WebAssembly.Module(merged);
{
  let p = 8;
  const readLeb = () => { let value = 0, shift = 0, byte; do { byte = merged[p++]; value |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80); return value; };
  while (p < merged.length) {
    const id = merged[p++];
    const size = readLeb();
    if (id !== 1) { p += size; continue; }
    const end = p + size;
    const entryCount = readLeb();
    if (entryCount !== count) throw new Error(`merged type count ${entryCount} != ${count}`);
    for (const [index, entry] of typeEntries.entries()) {
      const got = merged.slice(p, p + entry.length);
      if (got.join(',') !== entry.join(',')) throw new Error(`type entry ${index} differs from ${list[index].name}`);
      p += entry.length;
    }
    if (p !== end) throw new Error('type section length drift');
    break;
  }
}
const calls = [];
const instance = new WebAssembly.Instance(module, {
  e: new Proxy({}, { get: (_, importName) => {
    // Each trampoline re-exports one import; the import's own signature decides
    // the wasm-side return conversion (i64 results must come back as BigInt).
    const entry = typeEntries[Number(String(importName).slice(2))];
    const resultType = entry[3 + entry[1]];
    return (...args) => {
      calls.push([String(importName), args]);
      return resultType === 0x7e ? BigInt(args.length) : args.length;
    };
  } }),
});
for (const [index, { name: stubName }] of list.entries()) {
  const entry = typeEntries[index];
  const arity = entry[1];
  const params = entry.slice(2, 2 + arity);
  const expectsResult = entry[2 + arity] !== 0;
  const returnType = entry[3 + arity];
  const toJs = (type, value) => (type === 0x7e ? BigInt(value) : value);
  const args = params.map((type, a) => toJs(type, a + 1));
  const result = instance.exports['f' + index](...args);
  const expected = expectsResult ? toJs(returnType, arity) : undefined;
  if (result !== expected) {
    throw new Error(`export f${index} did not forward (arity ${arity}, expected ${String(expected)}, got ${String(result)})`);
  }
}
if (calls.length !== list.length) throw new Error('not every export forwarded');

writeFileSync(vendor + 'callbacks.wasm', merged);
const nameMap = list.map(({ key }, index) => [key, exportNames[index]]);
writeFileSync(vendor + 'callback-names.json', JSON.stringify(nameMap));

// Patch the loader once: one static import, signature-keyed export names, and
// a request-time Proxy import object so every install call wires its own host
// function without touching the other 381 imports.
let loader = readFileSync(vendor + 'worker-loader.mjs', 'utf8');
const patched = "import callbacksModule from './callbacks.wasm';";
if (!loader.includes(patched)) {
  const imports = loader.match(/^import cb\d+ from '\.\/callback-\d+\.wasm';\n/gm);
  if (!imports || imports.length !== count) throw new Error(`expected ${count} stub imports, found ${imports?.length}`);
  loader = loader.replace(imports[0], patched + '\n');
  loader = loader.replace(/^import cb\d+ from '\.\/callback-\d+\.wasm';\n/gm, '');
  const registry = /const callbackModules = new Map\(\[\[.*\]\]\);/;
  if (!registry.test(loader)) throw new Error('callbackModules registry not found');
  const entries = nameMap.map(([key, name]) => `[${JSON.stringify(key)},${JSON.stringify(name)}]`).join(',');
  loader = loader.replace(registry, `const callbackExports = new Map([${entries}]);`);
  const instantiate = 'new WebAssembly.Instance(callbackModules.get(wasmCode.join(\',\')), { e: { f: func } }).exports["f"]';
  if (!loader.includes(instantiate)) throw new Error('instantiation site not found');
  loader = loader.replace(instantiate,
    'new WebAssembly.Instance(callbacksModule, { e: new Proxy({}, { get: () => func }) }).exports[callbackExports.get(wasmCode.join(\',\'))]');
  writeFileSync(vendor + 'worker-loader.mjs', loader);
}
console.log(`merged ${count} stubs into callbacks.wasm (${merged.length} bytes); forwarding verified for all exports; loader patched.`);
