/**
 * dsh-nmg build: node-half lib (host plugin: tools + automatic recall) and the
 * browser client bundle (the tool.call.toolview cards), speaking the dsh
 * module-loader protocol (window.__ModuleLoader__.load). Mirrors dsh-genui's
 * tsdown setup simplified for one package.
 */
import { type UserConfig } from 'tsdown'

const ID = '@nmg/dsh-nmg'

/** Module-table entries the client bundle leaves external (resolved via the
 * loader's require). The client imports only react; everything else (slots/)
 * theme/ctx) is a runtime builtin, so the externals list is minimal. */
const CLIENT_EXTERNALS = ['react']

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const libConfig: UserConfig = {
  name: ID,
  entry: ['src/plugin/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default [libConfig, clientConfig]
