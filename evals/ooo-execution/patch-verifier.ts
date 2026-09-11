import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const typescriptPath = createRequire(import.meta.url).resolve("typescript");
const syntaxCheck = `
const ts = require(process.argv[2]);
const source = require('node:fs').readFileSync(process.argv[1], 'utf8');
const result = ts.transpileModule(source, { fileName: 'candidate.ts', reportDiagnostics: true });
const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
for (const error of errors) console.error(ts.flattenDiagnosticMessageText(error.messageText, '\\n'));
process.exitCode = errors.length ? 1 : 0;
`;

/** Host-owned oracle for this narrow probe, never supplied by the worker.
 * The target function must be the final export in this frozen source fixture.
 * This proves only an exact rename, not arbitrary program correctness. */
export function expectedRename(source: string): string {
  const marker = "export function nextTask(";
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) !== -1)
    throw new Error("rename baseline has no unique nextTask function");
  const prefix = source.slice(0, start);
  const body = source.slice(start);
  if (
    !body.includes("const byId = new Map(") ||
    /\bplanIndex\b/.test(body) ||
    /\bexport\b/.test(body.slice(marker.length))
  )
    throw new Error("rename baseline is incompatible with the fixed oracle");
  return prefix + body.replace(/\bbyId\b/g, "planIndex");
}

/** Probe-specific host check. Parses only; never executes candidate code.
 * This is neither a sandbox nor the task coordinator's final admission. */
export async function verifyRenameCandidate(
  source: string,
  candidate: string,
  checkId: string = randomUUID(),
) {
  const expected = expectedRename(source);
  if (candidate !== expected) return { verdict: "reject" as const, reason: "not the exact rename" };
  const directory = await mkdtemp(join(tmpdir(), "nmg-ooo-candidate-"));
  try {
    const file = join(directory, "candidate.ts");
    await writeFile(file, candidate, { encoding: "utf8", flag: "wx" });
    const startedAt = new Date().toISOString();
    const check = await new Promise<{ ok: boolean; inconclusive: boolean; log: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          ["-e", syntaxCheck, file, typescriptPath],
          {
            cwd: directory,
            timeout: 10_000,
            maxBuffer: 4_000,
            // No inherited provider credentials or NODE_OPTIONS preload hooks.
            env: {},
          },
          (error, stdout, stderr) =>
            resolve({
              ok: !error,
              inconclusive: !!error && (error.killed || typeof error.code !== "number"),
              log: (stdout + stderr).slice(0, 4_000),
            }),
        );
      },
    );
    const unchanged = (await readFile(file, "utf8")) === expected;
    const verdict = check.inconclusive
      ? ("undecidable" as const)
      : check.ok && unchanged
        ? ("accept" as const)
        : ("reject" as const);
    return { verdict, checkId, startedAt, finishedAt: new Date().toISOString(), log: check.log };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
