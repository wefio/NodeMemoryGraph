import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { moduleSpecifiers } from "../../scripts/verification-impact-probe.ts";

const { values } = parseArgs({ options: { root: { type: "string" } } });
if (!values.root)
  throw new Error("usage: node --experimental-strip-types <script> --root <repository>");
const root = resolve(values.root);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
const revision = git("rev-parse", "HEAD").trim();
if (git("status", "--porcelain", "--", "src").trim())
  throw new Error("src must match the measured revision");
const files = git("ls-files", "-z", "--", "src")
  .split("\0")
  .filter((file) => /\.(?:c|m)?tsx?$/.test(file));
if (!files.length) throw new Error("no tracked TypeScript source files found");
const groups = new Set(
  files
    .map((file) => file.split("/"))
    .filter((parts) => parts.length > 2)
    .map((parts) => parts[1]),
);

function group(path) {
  const parts = path.split("/");
  return parts[0] === "src"
    ? parts.length > 2 || groups.has(parts[1])
      ? parts[1]
      : "src-root"
    : `outside:${parts[0]}`;
}

const edges = new Map();
const computed = [];
let localCount = 0;
let importTypes = 0;
for (const file of files) {
  const source = readFileSync(resolve(root, file), "utf8");
  const { specifiers, unknown } = moduleSpecifiers(file, source);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
      importTypes++;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  computed.push(...unknown);
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const target = relative(root, resolve(root, dirname(file), specifier))
      .split(sep)
      .join("/");
    const from = group(file);
    const to = group(target);
    if (from === to) continue;
    localCount++;
    const key = `${from} -> ${to}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push(`${file} -> ${specifier}`);
  }
}
if (!localCount) throw new Error("no cross-group references found; inspect input and parser");
const entries = [...edges].sort(([a], [b]) => a.localeCompare(b));
if (entries.reduce((sum, [, values]) => sum + values.length, 0) !== localCount)
  throw new Error("edge counts do not add up");
console.log(
  JSON.stringify(
    {
      root,
      revision,
      measuredAt: new Date().toISOString(),
      sourceFiles: files.length,
      importTypes,
      crossGroupReferences: localCount,
      computedPaths: computed,
      counts: Object.fromEntries(entries.map(([key, values]) => [key, values.length])),
      references: Object.fromEntries(entries),
    },
    null,
    2,
  ),
);
