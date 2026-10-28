/**
 * EdgeOne Makers build: one self-contained Node 20 ESM module.
 *
 * The wrangler build (scripts/build-backend.mjs) keeps `.wasm` files external
 * because workerd compiles them; Node cannot import wasm modules, so here both
 * sqlite artefacts are inlined as base64 and rehydrated into WebAssembly.Module
 * at cold start. That also removes every filesystem-path assumption.
 */
/* eslint-disable no-console -- deliberate build output */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectEntries, writeZip } from "./zip-writer.mjs";

const root = process.cwd();
const workspace = path.resolve(root, "..");
const outDir = path.join(root, "dist/edgeone");
const functionFile = path.join(outDir, "cloud-functions/[[default]].js");

execFileSync(process.execPath, [path.join(workspace, "scripts/generate-prompts.ts")], {
  cwd: workspace,
  stdio: "inherit",
});
// Run for its artifact only: with `stdio: inherit` this call returns null, so the
// previous code recorded the string "null" as the source revision on every EdgeOne
// build and a deployed function could not name the commit it came from.
execFileSync(process.execPath, [path.join(root, "scripts/generate-callbacks.mjs")], {
  cwd: root,
  stdio: "inherit",
});
const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: workspace,
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).trim()
    .length > 0;
const sourceRevision = revision + (dirty ? "+dirty" : "");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "cloud-functions"), { recursive: true });

/** Replaces `import wasm from './x.wasm'` with a lazily built WebAssembly.Module. */
const inlineWasm = {
  name: "inline-wasm",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.wasm$/ }, async (args) => {
      const bytes = fs.readFileSync(args.path).toString("base64");
      const module = `Buffer.from(${JSON.stringify(bytes)}, "base64")`;
      return {
        loader: "js",
        contents: `export default new WebAssembly.Module(${module});`,
        watchFiles: [args.path],
      };
    });
  },
};

await build({
  entryPoints: ["backend/edgeone-entry.mjs"],
  outfile: functionFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  legalComments: "none",
  define: { __NMG_SOURCE_REVISION__: JSON.stringify(sourceRevision) },
  alias: { "node:sqlite": path.join(root, "backend/sqlite.mjs") },
  external: ["node:*"],
  plugins: [inlineWasm],
});

// Makers routes by file path, so the catch-all must sit at the root of
// cloud-functions: `/add`, `/search`, `/health`, `/admin/*` and `/api/*` all
// have to reach the same handler. `/` is a separate route on the platform and
// [[default]] does not cover it, so index.js ships the same bundle.
fs.copyFileSync(functionFile, path.join(outDir, "cloud-functions/index.js"));

// The deployable folder: the function, empty deps (everything is bundled), and
// the platform settings the console would otherwise have to be told.
fs.writeFileSync(
  path.join(outDir, "edgeone.json"),
  JSON.stringify(
    {
      cloudFunctions: {
        maxDuration: 120,
        regions: {
          // Mainland project: function sits next to the COS bucket.
          mainland: ["ap-guangzhou"],
          // Overseas project: Hong Kong instead of the ap-singapore default.
          // The bucket is in Guangzhou, and HK<->GZ is one hop, while
          // SG<->GZ measured ~1s per COS operation.
          overseas: ["ap-hongkong"],
        },
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(
    { name: "nmg-memory-api-edgeone", private: true, type: "module", version: "0.0.0" },
    null,
    2,
  ),
);

// The deploy folder is uploaded verbatim, so a local `.env` left behind by
// `edgeone makers dev` must never ride along with the function.
for (const name of fs.readdirSync(outDir))
  if (/^\.env/.test(name)) fs.rmSync(path.join(outDir, name), { force: true, recursive: true });

const size = fs.statSync(functionFile).size;

// One top-level folder, matching the shape of the official templates
// (pages-functions-demo.zip, openai-agents-starter-node.zip).
const archive = writeZip(
  path.join(root, "dist/edgeone.zip"),
  collectEntries(outDir, "nmg-memory-api/"),
);
console.log(`Built EdgeOne Node function (${(size / 1024 / 1024).toFixed(2)} MiB) at dist/edgeone`);
console.log(
  `Packed dist/edgeone.zip (${archive.entries} entries, ${(archive.bytes / 1024 / 1024).toFixed(2)} MiB uncompressed)`,
);
