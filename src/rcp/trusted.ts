import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical, sha256 } from "./canonical.ts";

const POLICY = ".rcp/trusted-policy.json";
const MARKER = ".rcp-trusted-install.json";
const LIMIT = 256 * 1024 * 1024;
type Snapshot = Map<string, { mode: string; bytes: Buffer }>;
interface Obligation {
  id: string;
  claim: string;
  tests: string[];
  timeoutMs: number;
}
interface Policy {
  schema: "repository.trusted-policy/v1";
  candidateRoots: string[];
  obligations: Obligation[];
}
interface Installation {
  schema: "repository.trusted-install/v1";
  commit: string;
  sourceDigest: string;
  files: Array<{ path: string; mode: string }>;
  policyDigest: string;
  verifierDigest: string;
}
export interface TrustedResult {
  schema: "repository.trusted-result/v1";
  invocationId: string;
  candidate: { commit: string; digest: string };
  baseline: { commit: string; digest: string };
  verifierDigest: string;
  policyDigest: string;
  runtime: string;
  decision: "passed" | "failed" | "blocked";
  diagnostics: string[];
  obligations: Array<{ id: string; claim: string; status: "passed" | "failed"; output: string }>;
}

function executionEnvironment(): NodeJS.ProcessEnv {
  // A verifier may itself run under node:test. Its acceptance runner is a new
  // invocation, not a child test file in the parent's private runner protocol.
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("NODE_TEST_") && name !== "NODE_OPTIONS" && name !== "NODE_PATH",
    ),
  );
}

function command(executable: string, args: string[], cwd: string, input?: string): Buffer {
  const result = spawnSync(executable, args, {
    cwd,
    input,
    env: executionEnvironment(),
    maxBuffer: LIMIT,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr?.toString() ?? `${executable} failed`);
  return result.stdout;
}
function localPath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          part.includes(":") ||
          [...part].some((character) => character.charCodeAt(0) < 32),
      )
  )
    throw new Error(`unsafe repository path: ${path}`);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..`) && !isAbsolute(rel));
}
function snapshot(repository: string, revision: string): { commit: string; files: Snapshot } {
  // Revision is resolved once; all subsequent reads address immutable Git objects.
  const commit = command(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    repository,
  )
    .toString()
    .trim();
  const entries = command("git", ["ls-tree", "-rz", "--full-tree", commit], repository)
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
      if (!match)
        throw new Error("trusted snapshots support regular files only (no symlinks or submodules)");
      const mode = match[1]!;
      const oid = match[2]!;
      const path = match[3]!;
      localPath(path);
      if (path === MARKER)
        throw new Error("installation marker cannot be part of a source revision");
      return { mode, oid, path };
    });
  if (!entries.length) throw new Error("empty candidate snapshot");
  if (new Set(entries.map((entry) => entry.path.toLowerCase())).size !== entries.length)
    throw new Error("case-colliding snapshot paths");
  const blobs = command(
    "git",
    ["cat-file", "--batch"],
    repository,
    entries.map((entry) => entry.oid).join("\n") + "\n",
  );
  let offset = 0;
  const files: Snapshot = new Map();
  for (const entry of entries) {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString();
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.oid) throw new Error("invalid Git blob response");
    const size = Number(match[2]);
    offset = end + 1;
    if (offset + size >= blobs.length) throw new Error("truncated Git blob response");
    files.set(entry.path, { mode: entry.mode, bytes: blobs.subarray(offset, offset + size) });
    offset += size + 1;
  }
  return { commit, files };
}
function identity(files: Snapshot): string {
  return digestCanonical(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, file]) => [path, file.mode, sha256(file.bytes)]),
  );
}
function materialize(files: Snapshot, root: string): void {
  for (const [path, file] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), file.bytes);
    if (process.platform !== "win32")
      chmodSync(join(root, path), file.mode === "100755" ? 0o755 : 0o644);
  }
}
const ALLOWED_CANDIDATE_ROOTS = [
  "src",
  "docs",
  ".pi/extensions",
  "claude-plugins",
  "workbuddy-plugin",
  "dsh/dsh-nmg/src",
];

function parsePolicy(files: Snapshot): Policy {
  const policy = JSON.parse(files.get(POLICY)?.bytes.toString() ?? "null") as Policy | null;
  if (
    !policy ||
    policy.schema !== "repository.trusted-policy/v1" ||
    !Array.isArray(policy.candidateRoots) ||
    !policy.candidateRoots.length ||
    !Array.isArray(policy.obligations) ||
    !policy.obligations.length
  )
    throw new Error("missing or invalid trusted policy/obligations");
  return policy;
}

function checkCandidateRoots(roots: string[]): void {
  for (const root of roots) {
    if (typeof root !== "string") throw new Error("invalid candidate root");
    localPath(root);
    if (!ALLOWED_CANDIDATE_ROOTS.includes(root))
      throw new Error(`unsupported candidate root: ${root}`);
  }
}

function checkAcceptanceTest(path: unknown, files: Snapshot): void {
  if (typeof path !== "string") throw new Error("invalid acceptance test path");
  localPath(path);
  if (!path.startsWith("tests/") || !path.endsWith(".test.ts") || !files.has(path))
    throw new Error(`missing baseline acceptance test: ${path}`);
}

function checkObligationShape(obligation: Obligation): void {
  if (!obligation || typeof obligation.id !== "string" || !obligation.id.trim())
    throw new Error("missing obligation id");
  if (typeof obligation.claim !== "string" || !obligation.claim.trim())
    throw new Error("missing obligation claim");
  if (!Array.isArray(obligation.tests) || !obligation.tests.length)
    throw new Error("obligation requires acceptance tests");
  if (!Number.isSafeInteger(obligation.timeoutMs) || obligation.timeoutMs <= 0)
    throw new Error("invalid obligation timeout");
}

function checkObligations(obligations: Obligation[], files: Snapshot): void {
  const ids = new Set<string>();
  for (const obligation of obligations) {
    checkObligationShape(obligation);
    if (ids.has(obligation.id)) throw new Error("duplicate obligation id");
    ids.add(obligation.id);
    for (const path of obligation.tests) checkAcceptanceTest(path, files);
  }
}

function policyFrom(files: Snapshot): Policy {
  const policy = parsePolicy(files);
  checkCandidateRoots(policy.candidateRoots);
  checkObligations(policy.obligations, files);
  return policy;
}
function npmCi(root: string): void {
  if (!existsSync(join(root, "package-lock.json"))) {
    const manifest = existsSync(join(root, "package.json"))
      ? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>)
      : {};
    if (
      ["dependencies", "devDependencies", "optionalDependencies"].some(
        (key) => Object.keys(manifest[key] ?? {}).length > 0,
      )
    )
      throw new Error("trusted dependency installation requires package-lock.json");
    return;
  }
  const npm = process.env.npm_execpath;
  if (npm)
    command(process.execPath, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  else if (process.platform === "win32")
    command(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "npm ci --ignore-scripts --no-audit --no-fund"],
      root,
    );
  else command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
}

/** Explicit approval creates a NEW installation; it never updates an existing trust root. */
export function installTrusted(
  repository: string,
  revision: string,
  destination: string,
): Installation {
  repository = realpathSync(
    command("git", ["rev-parse", "--show-toplevel"], realpathSync(repository)).toString().trim(),
  );
  destination = resolve(destination);
  if (existsSync(destination))
    throw new Error(
      "trusted installation destination must not exist; approve a new version separately",
    );
  const parent = realpathSync(dirname(destination));
  if (inside(repository, parent))
    throw new Error("trusted installation must be outside the candidate repository");
  const { commit, files } = snapshot(repository, revision);
  const policy = policyFrom(files);
  for (const path of ["src/rcp/trusted.ts", "src/rcp/canonical.ts"])
    if (!files.has(path)) throw new Error(`baseline lacks verifier: ${path}`);
  const installation: Installation = {
    schema: "repository.trusted-install/v1",
    commit,
    sourceDigest: identity(files),
    files: [...files].map(([path, file]) => ({ path, mode: file.mode })),
    policyDigest: digestCanonical(policy),
    verifierDigest: digestCanonical(
      ["src/rcp/trusted.ts", "src/rcp/canonical.ts"].map((path) => sha256(files.get(path)!.bytes)),
    ),
  };
  mkdirSync(destination);
  try {
    materialize(files, destination);
    npmCi(destination);
    writeFileSync(join(destination, MARKER), JSON.stringify(installation, null, 2) + "\n", {
      flag: "wx",
    });
    return installation;
  } catch (cause) {
    rmSync(destination, { recursive: true, force: true });
    throw cause;
  }
}
function installedFiles(root: string, installation: Installation): Snapshot {
  if (installation.schema !== "repository.trusted-install/v1" || !Array.isArray(installation.files))
    throw new Error("invalid trusted installation");
  const files: Snapshot = new Map();
  for (const { path, mode } of installation.files) {
    localPath(path);
    if (mode !== "100644" && mode !== "100755") throw new Error("invalid installed file mode");
    files.set(path, { mode, bytes: readFileSync(join(root, path)) });
  }
  if (identity(files) !== installation.sourceDigest)
    throw new Error("trusted installation source changed; approve a new installation");
  return files;
}
export function testOutputPassed(output: string): boolean {
  const count = (name: string) => {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, "gm"))];
    return matches.length === 1 ? Number(matches[0]![1]) : NaN;
  };
  return (
    count("tests") > 0 &&
    count("tests") === count("pass") &&
    ["fail", "cancelled", "skipped", "todo"].every((name) => count(name) === 0)
  );
}

function loadInstallationState(root: string): {
  installation: Installation;
  baseline: Snapshot;
  policy: Policy;
  verifierDigest: string;
} {
  const installation = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as Installation;
  const baseline = installedFiles(root, installation);
  const policy = policyFrom(baseline);
  const verifierDigest = digestCanonical(
    ["src/rcp/trusted.ts", "src/rcp/canonical.ts"].map((path) => sha256(baseline.get(path)!.bytes)),
  );
  if (
    digestCanonical(policy) !== installation.policyDigest ||
    verifierDigest !== installation.verifierDigest
  )
    throw new Error("trusted verifier or policy changed; approve a new installation");
  return { installation, baseline, policy, verifierDigest };
}

function mutablePath(path: string, policy: Policy): boolean {
  return (
    policy.candidateRoots.some((prefix) => path.startsWith(prefix + "/")) &&
    !/(^|\/)(package\.json|package-lock\.json|tsconfig[^/]*\.json)$/.test(path)
  );
}

function policyChangeDiagnostics(
  baseline: Snapshot,
  candidateFiles: Snapshot,
  policy: Policy,
): string[] {
  const diagnostics: string[] = [];
  for (const path of new Set([...baseline.keys(), ...candidateFiles.keys()])) {
    const before = baseline.get(path);
    const after = candidateFiles.get(path);
    if (
      !mutablePath(path, policy) &&
      (!before || !after || before.mode !== after.mode || !before.bytes.equals(after.bytes))
    )
      diagnostics.push(`policy-change requires separate approval: ${path}`);
  }
  return diagnostics;
}

function runObligationTest(
  workspace: string,
  obligation: Obligation,
): { id: string; claim: string; status: "passed" | "failed"; output: string } {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "--test-reporter=tap", ...obligation.tests],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: obligation.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: executionEnvironment(),
    },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error?.message ?? ""}`;
  const passed =
    !run.error && !run.signal && run.status === 0 && testOutputPassed(run.stdout ?? "");
  return {
    id: obligation.id,
    claim: obligation.claim,
    status: passed ? "passed" : "failed",
    output: output.slice(-8000),
  };
}

function snapshotMutationDiagnostics(candidateFiles: Snapshot, workspace: string): string[] {
  const diagnostics: string[] = [];
  for (const [path, file] of candidateFiles) {
    if (
      !existsSync(join(workspace, path)) ||
      !file.bytes.equals(readFileSync(join(workspace, path)))
    )
      diagnostics.push(`snapshot modified during verification: ${path}`);
  }
  return diagnostics;
}

/** The caller must execute this module from the separately approved installation. No evidence reuse. */
export function verifyTrusted(root: string, repository: string, revision: string): TrustedResult {
  root = realpathSync(root);
  repository = command("git", ["rev-parse", "--show-toplevel"], realpathSync(repository))
    .toString()
    .trim();
  if (inside(repository, root) || inside(root, repository))
    throw new Error("trusted installation and candidate must be separate directories");
  const { installation, baseline, policy, verifierDigest } = loadInstallationState(root);
  const candidate = snapshot(repository, revision);
  const result: TrustedResult = {
    schema: "repository.trusted-result/v1",
    invocationId: randomUUID(),
    candidate: { commit: candidate.commit, digest: identity(candidate.files) },
    baseline: { commit: installation.commit, digest: installation.sourceDigest },
    verifierDigest,
    policyDigest: installation.policyDigest,
    runtime: process.version,
    decision: "blocked",
    diagnostics: policyChangeDiagnostics(baseline, candidate.files, policy),
    obligations: [],
  };
  if (result.diagnostics.length) return result;
  const workspace = mkdtempSync(join(tmpdir(), "nmg-trusted-"));
  try {
    materialize(candidate.files, workspace);
    // Relative test imports now resolve to candidate product code, not installed product code.
    if (existsSync(join(root, "node_modules")))
      symlinkSync(
        join(root, "node_modules"),
        join(workspace, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    for (const obligation of policy.obligations)
      result.obligations.push(runObligationTest(workspace, obligation));
    result.diagnostics.push(...snapshotMutationDiagnostics(candidate.files, workspace));
    installedFiles(root, installation);
    result.decision =
      !result.diagnostics.length &&
      result.obligations.length === policy.obligations.length &&
      result.obligations.every((entry) => entry.status === "passed")
        ? "passed"
        : "failed";
    return result;
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function runTrustedCli(args: string[]): number {
  const [operation, repository, revision, destination] = args;
  if (
    !repository ||
    !revision ||
    (operation === "install"
      ? !destination || args.length !== 4
      : operation !== "verify" || args.length !== 3)
  )
    throw new Error(
      "Usage: trusted.ts install <repository> <reviewed-commit> <new-external-directory> | verify <candidate-repository> <commit>",
    );
  if (operation === "install") {
    process.stdout.write(
      JSON.stringify(installTrusted(repository, revision, destination!), null, 2) + "\n",
    );
    return 0;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const sourceEntry = join(root, "src", "rcp", "trusted.ts");
  if (resolve(fileURLToPath(import.meta.url)) !== resolve(sourceEntry)) {
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", sourceEntry, ...args],
      { stdio: "inherit", windowsHide: true, env: executionEnvironment() },
    );
    return child.error || child.signal ? 1 : (child.status ?? 1);
  }
  const result = verifyTrusted(root, repository, revision);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.decision === "passed" ? 0 : result.decision === "blocked" ? 2 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runTrustedCli(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
