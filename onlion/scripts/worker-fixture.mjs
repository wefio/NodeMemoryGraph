import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))('miniflare');
const root = path.resolve(import.meta.dirname, '..');
const modules = [
  { type: 'ESModule', path: path.join(root, 'dist/server/index.js') },
  { type: 'ESModule', path: path.join(root, 'dist/server/sqlite/worker-loader.mjs') },
  { type: 'CompiledWasm', path: path.join(root, 'dist/server/sqlite/sqlite3.wasm') },
    { type: 'CompiledWasm', path: path.join(root, 'dist/server/sqlite/callbacks.wasm') },
];

/** Same built Worker, WASM modules and compatibility target for every API test. */
export function createWorkerFixture({ storage = false, bindings = {}, outboundService } = {}) {
  return new Miniflare({
    r2Persist: storage,
    workers: ['a', 'b'].map(name => ({
      name, modules, modulesRoot: path.join(root, 'dist/server'),
      compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
      bindings: {
        NMG_API_KEY: 'test-key', NMG_OWNER_EMAIL: 'owner@example.test',
        NMG_SELFTEST_TOKEN: 'self-test-key',
        NMG_SELFTEST_EXPIRES_AT: String(name === 'b' ? 1 : Date.now() + 3600000),
        ...bindings,
      },
      r2Buckets: { MEMORY: 'memory' },
      ...(outboundService ? { outboundService } : {}),
    })),
  });
}
