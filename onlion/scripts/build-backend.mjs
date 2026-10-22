/* eslint-disable no-console -- deliberate test/diagnostic output */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const workspace = path.resolve(root, '..');
execFileSync(process.execPath, [path.join(workspace, 'scripts/generate-prompts.ts')], { cwd: workspace, stdio: 'inherit' });
const revision = execFileSync(process.execPath, [path.join(root, 'scripts/generate-callbacks.mjs')], { cwd: root, stdio: 'inherit' });
execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).trim().length > 0;
const sourceRevision = revision + (dirty ? '+dirty' : '');
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/server', { recursive: true });
fs.cpSync('sqlite-wasm', 'dist/server/sqlite', { recursive: true, filter: (source) => !source.endsWith('callbacks.manifest.json') });
await build({
  entryPoints: ['backend/worker.mjs'], outfile: 'dist/server/index.js',
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  define: { 'import.meta.url': JSON.stringify('file:///tmp/nmg-worker.mjs'), '__NMG_SOURCE_REVISION__': JSON.stringify(sourceRevision) },
  alias: { 'node:sqlite': path.join(root, 'backend/sqlite.mjs') },
  external: ['node:*'],
  plugins: [{ name: 'sqlite-worker-modules', setup(b) {
    b.onResolve({ filter: /sqlite-wasm\/worker-loader\.mjs$/ }, () => ({path:'./sqlite/worker-loader.mjs',external:true}));
    b.onResolve({ filter: /sqlite-wasm\/sqlite3\.wasm$/ }, () => ({path:'./sqlite/sqlite3.wasm',external:true}));
  }}]
});
const hosting = fs.existsSync('.openai/hosting.json') ? JSON.parse(fs.readFileSync('.openai/hosting.json')) : {};
const workerName = process.env.NMG_WORKER_NAME ?? hosting.worker_name ?? 'nmg-memory-api';
const bucketName = process.env.NMG_R2_BUCKET ?? hosting.bucket_name ?? 'nmg-memory-snapshots';
if (fs.existsSync('.openai/hosting.json')) {
  fs.mkdirSync('dist/.openai', { recursive: true });
  fs.copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
}
fs.writeFileSync('dist/server/wrangler.json', JSON.stringify({
  name: workerName, main: './index.js', compatibility_date: '2026-05-15',
  compatibility_flags: ['nodejs_compat'], no_bundle: true, find_additional_modules:true,
  rules:[{type:'CompiledWasm',globs:['**/*.wasm'],fallthrough:true},{type:'ESModule',globs:['**/*.mjs'],fallthrough:true}],
  r2_buckets:[{binding:'MEMORY',bucket_name:bucketName}]
}, null, 2));
console.log('Built NMG daemon core for AML, request-scoped SQLite WASM, and R2-backed API.');
