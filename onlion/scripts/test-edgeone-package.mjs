/* eslint-disable no-console -- deliberate test output */
/* Pins the EdgeOne packaging contract and the two loader facts that were learned the hard way.
 *
 * Why this exists: on 2026-10-30 the shipped bundle deferred **both** wasm modules behind a
 * factory. `callbacks.wasm` is imported by the generated loader as a real `WebAssembly.Module`,
 * so `new WebAssembly.Instance(fn, ...)` threw inside `runSQLite3PostLoadInit` and every `/search`
 * that needed SQLite answered 503 in 75-150 ms - while `/add` kept working, because the accept
 * never touches SQLite. `npm run verify` could not see it: Miniflare runs the wrangler build, which
 * never executes this plugin. The endpoint found it.
 *
 * So the assertions are about the artefacts this build produces, not about the source:
 *   1. `callbacks.wasm` is inlined as an eager `new WebAssembly.Module(...)`;
 *   2. `sqlite3.wasm` is inlined behind a factory, so a request that never reads a partition does
 *      not decode or compile 1.5 MiB;
 *   3. both modules actually compile from the bytes in the bundle, which is what the loader does;
 *   4. the OPFS VFS installers are gated off through `globalThis.sqlite3ApiConfig`, the only place
 *      the loader reads that setting (`init()`'s argument is ignored - tried, silently inert).
 *
 * No network, no Miniflare: esbuild + V8.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const outDir = path.join(root, "dist/edgeone");
const bundle = path.join(outDir, "cloud-functions/[[default]].js");

console.log("building the EdgeOne function for the packaging assertions…");
execFileSync(process.execPath, [path.join(root, "scripts/build-edgeone.mjs")], {
  cwd: root,
  stdio: "inherit",
});
const source = fs.readFileSync(bundle, "utf8");

// 1. callbacks.wasm: eager module, because the generated loader imports it as one.
assert.match(
  source,
  /var callbacks_default = new WebAssembly\.Module\(Buffer\.from\(/,
  "callbacks.wasm must stay an eager WebAssembly.Module: the loader does new WebAssembly.Instance(callbacksModule, ...)",
);
assert.doesNotMatch(
  source,
  /function compiledWasm\(\).*callbacks/s,
  "callbacks.wasm must not be wrapped in the lazy factory",
);

// 2. sqlite3.wasm: lazy factory, and the bytes are still in the bundle (no filesystem dependency).
assert.match(
  source,
  /function compiledWasm\d*\(\) \{\s*compiled\d* \?\?= new WebAssembly\.Module\(Buffer\.from\(encodedBytes\d*, "base64"\)\);\s*return compiled\d*;\s*\}/,
  "sqlite3.wasm must be compiled on first use, not at module scope",
);

// 3. Both inline payloads must still be real wasm: compile them the way the bundle does.
const base64Payloads = [...source.matchAll(/Buffer\.from\((?:"([A-Za-z0-9+/=]{200,})"|encodedBytes\d*), "base64"\)/g)]
  .map((match) => match[1])
  .filter(Boolean);
assert.ok(
  base64Payloads.length >= 1,
  "expected at least one inline base64 wasm payload in the bundle",
);
for (const payload of base64Payloads) {
  const module = new WebAssembly.Module(Buffer.from(payload, "base64"));
  assert.ok(
    WebAssembly.Module.exports(module).length > 0,
    "an inline wasm payload compiled but exports nothing",
  );
}

// 4. The OPFS gate must be set where the loader reads it.
assert.match(
  source,
  /globalThis\.sqlite3ApiConfig\s*=\s*\{/,
  "the OpfsVfs installers are gated on globalThis.sqlite3ApiConfig; init()'s argument is ignored",
);
assert.match(
  source,
  /vfs:\s*\{\s*opfs:\s*true\s*,\s*"opfs-wl":\s*true\s*\}/,
  "OPFS and opfs-wl must be disabled, not attempted",
);

// 5. And the entry still exports the handler the platform scans for.
assert.match(source, /export \{[\s\S]{0,200}onRequest/, "the built entry must export onRequest");

console.log(
  "PASS: EdgeOne packaging — callbacks.wasm eager, sqlite3.wasm lazy, both wasm payloads compile, OPFS gated off, onRequest exported.",
);
