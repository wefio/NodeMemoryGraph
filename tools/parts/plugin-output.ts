import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function preparePluginOutput(
  output: string,
  owner: string,
  folder = "plugin",
): Promise<string> {
  const directory = resolve(output, folder);
  if (relative(resolve(output), directory) !== folder)
    throw new Error("Invalid plugin output path");
  try {
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("Refusing to replace a linked plugin directory");
    const marker = JSON.parse(await readFile(join(directory, ".nmg-build.json"), "utf8"));
    if (marker.owner !== owner)
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
  await writeFile(join(directory, ".nmg-build.json"), JSON.stringify({ owner }));
  return directory;
}

export async function packPlugin(
  directory: string,
  output: string,
  ...requiredFiles: string[]
): Promise<string> {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run plugin packaging through its npm package script");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [npm, "pack", "--ignore-scripts", "--pack-destination", output, "--json"],
    { cwd: directory, windowsHide: true },
  );
  const packed = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const contents = new Set(packed[0]?.files.map((file) => file.path));
  if (packed.length !== 1 || !requiredFiles.every((file) => contents.has(file)))
    throw new Error("Plugin archive is missing a required file");
  return join(output, packed[0].filename);
}
