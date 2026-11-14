import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");

async function prepareOutput(output: string): Promise<string> {
  const directory = resolve(output, "plugin");
  if (relative(resolve(output), directory) !== "plugin")
    throw new Error("Invalid plugin output path");
  try {
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("Refusing to replace a linked plugin directory");
    const marker = JSON.parse(await readFile(join(directory, ".nmg-build.json"), "utf8"));
    if (marker.owner !== "nmg-codex-plugin")
      throw new Error("Refusing to replace an unmanaged plugin directory");
    await rm(directory, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await readdir(directory);
      throw new Error("Refusing to replace an unmanaged plugin directory", { cause: error });
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
    }
  }
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, ".nmg-build.json"),
    JSON.stringify({ owner: "nmg-codex-plugin" }),
  );
  return directory;
}

async function linkSkillOwners(
  source: string,
  destination: string,
  revision: string,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await linkSkillOwners(from, to, revision);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const text = await readFile(to, "utf8");
    const rewritten = text.replace(/\]\(([^)]+)\)/g, (whole, target: string) => {
      if (/^(?:[a-z]+:|#|\/)/i.test(target)) return whole;
      const [path, anchor] = target.split("#");
      const absolute = resolve(dirname(from), path!);
      const skillRelative = relative(join(root, "skills", "nmg-memory"), absolute);
      if (!skillRelative.startsWith(`..${sep}`)) return whole;
      const repoRelative = relative(root, absolute).split(sep).join("/");
      if (repoRelative.startsWith("../")) throw new Error("Skill link escapes repository");
      return `](https://github.com/wefio/NodeMemoryGraph/blob/${encodeURIComponent(revision)}/${encodeURI(repoRelative)}${anchor ? `#${anchor}` : ""})`;
    });
    await writeFile(to, rewritten);
  }
}

export async function buildCodexPlugin(options: {
  output: string;
  pack?: boolean;
  revision?: string;
}) {
  const output = resolve(options.output);
  const directory = await prepareOutput(output);
  const source = join(root, "codex-plugin");
  for (const name of [
    ".codex-plugin",
    ".mcp.json",
    ".agents",
    "hooks",
    "package.json",
    "README.md",
    "README.zh-CN.md",
  ]) {
    await cp(join(source, name), join(directory, name), { recursive: true });
  }
  await cp(join(root, "LICENSE"), join(directory, "LICENSE"));
  await cp(join(root, "skills", "nmg-memory"), join(directory, "skills", "nmg-memory"), {
    recursive: true,
  });
  await linkSkillOwners(
    join(root, "skills", "nmg-memory"),
    join(directory, "skills", "nmg-memory"),
    options.revision ?? "main",
  );
  const result = await build({
    entryPoints: [join(source, "main.ts")],
    outfile: join(directory, "scripts", "nmg.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22.19",
    metafile: true,
    banner: {
      js: 'import { createRequire as nmgCreateRequire } from "node:module"; const require = nmgCreateRequire(import.meta.url);',
    },
  });
  const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
  if (inputs.some((path) => /src\/(?:core\/store(?:\/|\.ts)|cli\/service\.ts)/.test(path))) {
    throw new Error("Codex client bundle imported the daemon/store implementation");
  }
  const sha256 = createHash("sha256")
    .update(await readFile(join(directory, "scripts", "nmg.mjs")))
    .digest("hex");
  let archive: string | undefined;
  if (options.pack) {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run packaging through npm run codex:package");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [npm, "pack", "--ignore-scripts", "--pack-destination", output, "--json"],
      { cwd: directory, windowsHide: true },
    );
    const packed = JSON.parse(stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    if (
      packed.length !== 1 ||
      !packed[0]?.files.some((file) => file.path === ".codex-plugin/plugin.json")
    ) {
      throw new Error("Plugin archive is missing its Codex manifest");
    }
    archive = join(output, packed[0].filename);
  }
  const receipt = { directory, archive, sha256, bundledInputs: inputs.length };
  await writeFile(join(output, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      pack: { type: "boolean", default: false },
      revision: { type: "string" },
    },
  });
  if (!values.output) throw new Error("Required: --output <release-directory>");
  console.log(
    JSON.stringify(
      await buildCodexPlugin({
        output: values.output,
        pack: values.pack,
        revision: values.revision,
      }),
    ),
  );
}
