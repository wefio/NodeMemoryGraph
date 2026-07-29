import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, normalize, resolve } from "node:path";

interface PackEntry {
  files: Array<{ path: string }>;
}

const root = resolve(import.meta.dirname, "..");
const raw =
  process.platform === "win32"
    ? execFileSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "npm pack --dry-run --json"],
        {
          cwd: root,
          encoding: "utf8",
        },
      )
    : execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
      });
const report = JSON.parse(raw) as Record<string, PackEntry>;
const entry = Object.values(report)[0];
if (!entry) throw new Error("npm pack did not return a package report");

const packed = new Set(entry.files.map((file) => normalize(file.path)));
const visited = new Set<string>();
const missing = new Set<string>();
const queue = ["extensions/nmg.ts", "bin/nmg.mjs"];

while (queue.length > 0) {
  const relative = normalize(queue.pop()!);
  if (visited.has(relative)) continue;
  visited.add(relative);
  if (!packed.has(relative)) {
    missing.add(relative);
    continue;
  }

  const source = readFileSync(resolve(root, relative), "utf8");
  for (const specifier of relativeImports(source)) {
    const dependency = resolveImport(relative, specifier);
    if (dependency) queue.push(dependency);
  }
}

if (missing.size > 0) {
  throw new Error(
    `packed Pi extension has missing runtime imports:\n${[...missing]
      .sort()
      .map((path) => `- ${path}`)
      .join("\n")}`,
  );
}

process.stdout.write(
  `package closure ok: ${visited.size} runtime files, ${packed.size} packed files\n`,
);

function relativeImports(source: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]!);
  return imports;
}

function resolveImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const imported = normalize(resolve(dirname(resolve(root, importer)), specifier));
  const relative = imported.slice(root.length + 1);
  if (extname(relative)) return relative;
  return `${relative}.ts`;
}
