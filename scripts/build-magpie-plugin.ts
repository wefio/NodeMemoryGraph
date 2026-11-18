import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { packPlugin, preparePluginOutput } from "../tools/parts/plugin-output.ts";

const root = resolve(import.meta.dirname, "..");

export async function buildMagpiePlugin(options: { output: string; pack?: boolean }) {
  const output = resolve(options.output);
  const directory = await preparePluginOutput(output, "nmg-magpie-plugin", "nmg");
  for (const name of ["package.json", "options.schema.json", "ui", "README.md", "README.zh-CN.md"])
    await cp(join(root, "magpie-plugin", name), join(directory, name), { recursive: true });
  await cp(join(root, "LICENSE"), join(directory, "LICENSE"));
  await cp(
    join(root, "src/integration/adapter-manifests/magpie.json"),
    join(directory, "adapter-manifest.json"),
  );
  await cp(
    join(root, "src/integration/adapter-manifests/adapter-manifest.schema.json"),
    join(directory, "adapter-manifest.schema.json"),
  );
  const result = await build({
    entryPoints: [join(root, "magpie-plugin/index.ts")],
    outfile: join(directory, "index.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22.19",
    metafile: true,
    banner: {
      js: 'import { createRequire as nmgRequire } from "node:module"; const require = nmgRequire(import.meta.url);',
    },
  });
  const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
  if (
    inputs.some((path) =>
      /src\/(?:core\/(?:store(?:\/|\.ts)|memory\/)|cli\/(?:service|operator)\.ts)/.test(path),
    )
  )
    throw new Error("Magpie client bundle imported a memory backend or daemon implementation");
  const sha256 = createHash("sha256")
    .update(await readFile(join(directory, "index.mjs")))
    .digest("hex");
  const archive = options.pack
    ? await packPlugin(
        directory,
        output,
        "adapter-manifest.json",
        "adapter-manifest.schema.json",
        "options.schema.json",
        "ui/page.html",
        "index.mjs",
      )
    : undefined;
  const receipt = { directory, archive, sha256, bundledInputs: inputs.length };
  await writeFile(join(output, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { output: { type: "string" }, pack: { type: "boolean", default: false } },
  });
  if (!values.output) throw new Error("Required: --output <release-directory>");
  process.stdout.write(
    JSON.stringify(await buildMagpiePlugin({ output: values.output, pack: values.pack })) + "\n",
  );
}
