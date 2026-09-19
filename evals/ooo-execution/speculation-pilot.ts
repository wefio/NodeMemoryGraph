// E arm (bounded speculation), the first fidelity instrument for the design's lifecycle: one declared
// fact - whether this round needs the unit at all - one candidate prepared ahead of it, and the shared
// layer's own three outcomes deciding what happens to that candidate.
//
// The arm compares two things for each value of the fact, because the design asks for latency, extra
// cost and quality separately rather than as one "gain":
//
//   baseline    : the fact is decided first; if it is true, the unit runs then.
//   speculation : the unit is prepared before the fact; when the fact holds, the prepared candidate is
//                 published (the host still verifies it - that is the quality term), and when it does
//                 not, `speculationOutcome` discards the candidate and its branch session is closed.
//
// `--live` is required and `PI_PROVIDER`/`PI_MODEL` must be named: the operator authorizes the spend.
// A published candidate is verified by running the unit's own frozen check against it, in a copy of the
// fixture directory, so the quality term is a real check result and not the model's own claim.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { patchCandidate, preparePatchWork } from "../../src/integration/ooo-patch.ts";
import {
  speculationOutcome,
  type ResolvedPredicate,
  type SpeculationCandidate,
} from "../../src/integration/ooo-execution.ts";
import {
  createPiSessionRunner,
  patchSessionInput,
} from "../../.pi/extensions/nmg/ooo-execution.ts";

/** A named provider and model, refused by name rather than defaulted: the operator names the spend. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} explicitly`);
  return value;
}

if (!process.argv.includes("--live"))
  throw new Error("pass --live explicitly: this calls the configured model");
const provider = required("PI_PROVIDER");
const model = required("PI_MODEL");
const reps = Number(process.env.E_REPS ?? 2);
const outDir = `.temp/e-arm`;

const FIXTURE = "evals/ooo-execution/fixtures/report";
const TARGET = `${FIXTURE}/beta.ts`;
const INSTRUCTION =
  "Implement betaSection in this directory so that beta.test.ts passes. It numbers the rows from one " +
  'in the order given, and describes itself with id "beta" and title "Beta". The interface file is ' +
  "frozen: do not change its shape, and do not edit any other file.";

/** The fact this arm guesses, and its evidence: the host's own answer, not the worker's. */
const PREDICATE = "this-round-needs-beta";

mkdirSync(outDir, { recursive: true });

/** The frozen work for one attempt, always under a fresh ticket: a discarded branch's ticket is never
 *  the real path's ticket, which is the design's "真实路径在新票据下重新执行". */
function frozenFor(label: string) {
  return preparePatchWork({
    taskId: `e-arm:${label}:${randomUUID()}`,
    attempt: 1,
    instruction: INSTRUCTION,
    files: { [TARGET]: readFileSync(TARGET, "utf8") },
    editable: [TARGET],
    // Fixed for every condition, and above the host default of three turns: a real attempt routinely
    // needs four, which is the same envelope fact the D arm recorded.
    limits: { turns: 6, reads: 3, timeoutMs: 120_000 },
  });
}

/** The quality term: run the unit's own frozen check against the candidate, in a copy of the fixture so
 *  the shared tree is never written to. Returns the check's own verdict. */
function verify(
  frozen: ReturnType<typeof frozenFor>,
  artifact: string,
  label: string,
): { ok: boolean; detail: string } {
  // A candidate that does not even parse as this work's envelope is a failed attempt with a reason,
  // which is the same rule the adapter applies: the pilot records it instead of crashing on it.
  let candidate: Readonly<Record<string, string>>;
  try {
    candidate = patchCandidate(frozen, artifact);
  } catch (error) {
    let keys: string;
    try {
      keys = Object.keys(JSON.parse(artifact)).join(",");
    } catch {
      keys = "not json";
    }
    return { ok: false, detail: `${(error as Error).message} (artifact keys: ${keys})` };
  }
  const text = candidate[TARGET];
  if (text === undefined) return { ok: false, detail: "the artifact names no editable file" };
  const dir = `${outDir}/candidate-${label}-${randomUUID().slice(0, 8)}`;
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(`${dir}/beta.ts`, text);
  try {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--test", `${dir}/beta.test.ts`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, detail: "the unit's own check passed" };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, detail: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.slice(-2000) };
  } finally {
    // The candidate tree is kept on purpose: a failed check is the evidence for why the quality term is
    // false, and the first run of this arm deleted it and could not say what went wrong.
  }
}

async function attempt(label: string): Promise<{
  frozen: ReturnType<typeof frozenFor>;
  tokens: number;
  turns: number;
  workMs: number;
  artifact?: string;
  failure?: string;
}> {
  const frozen = frozenFor(label);
  const startedAt = Date.now();
  const runner = await createPiSessionRunner({
    provider,
    modelId: model,
    patchMode: true,
    first: patchSessionInput(frozen),
  });
  try {
    const run = await runner.runUnit(patchSessionInput(frozen));
    return {
      frozen,
      tokens: run.tokens,
      turns: run.turns,
      workMs: Date.now() - startedAt,
      ...(run.artifact ? { artifact: run.artifact } : { failure: "no artifact" }),
    };
  } catch (error) {
    // One attempt that misses its bounded contract is a recorded outcome of this arm, not a reason to
    // abandon the run: the design asks what a wrong guess costs, and a failed attempt is part of that.
    return {
      frozen,
      tokens: 0,
      turns: 0,
      workMs: Date.now() - startedAt,
      failure: (error as Error).message.slice(0, 200),
    };
  } finally {
    runner.dispose();
  }
}

const runs: Record<string, unknown>[] = [];
for (const factHolds of [true, false]) {
  for (let rep = 1; rep <= reps; rep += 1) {
    // baseline: the fact first, so nothing is prepared for a round that does not need the unit.
    const baseline = factHolds ? await attempt(`baseline-${rep}`) : undefined;
    const baselineRow = {
      arm: "baseline",
      fact: factHolds,
      rep,
      tokens: baseline?.tokens ?? 0,
      workMs: baseline?.workMs ?? 0,
      postFactMs: baseline?.workMs ?? 0,
      ...(() => {
        const checked =
          baseline?.artifact && baseline.frozen
            ? verify(baseline.frozen, baseline.artifact, `baseline-${rep}`)
            : null;
        return {
          quality: checked?.ok ?? null,
          ...(checked && !checked.ok ? { qualityDetail: checked.detail } : {}),
        };
      })(),
    };

    // speculation: the candidate first, then the shared rule decides what the fact means for it.
    const prepared = await attempt(`speculation-${rep}`);
    const assumption: SpeculationCandidate = {
      taskId: `speculation-${rep}`,
      assumptions: [{ predicateId: PREDICATE, version: "v1", expected: "true" }],
      speculativeSuccessors: [],
      irreversibleOperations: [],
    };
    const evidence: ResolvedPredicate[] = [
      { predicateId: PREDICATE, version: "v1", value: String(factHolds), authoritative: true },
    ];
    const decision = speculationOutcome(assumption, evidence);
    const published = decision.outcome === "publish" && prepared.artifact !== undefined;
    const verifyStartedAt = Date.now();
    const quality = published
      ? verify(prepared.frozen, prepared.artifact!, `speculation-${rep}`)
      : null;
    // A published candidate still has to cross the host boundary: latency saved is the work, not the check.
    const postFactMs = published ? Date.now() - verifyStartedAt : 0;
    const speculationRow = {
      arm: "speculation",
      fact: factHolds,
      rep,
      outcome: decision.outcome,
      sessionReusable: decision.sessionReusable,
      tokens: prepared.tokens,
      workMs: prepared.workMs,
      // What is left after the fact is decided: a published candidate still has to be verified, and a
      // discarded one has nothing left to do because the round does not need the unit.
      postFactMs,
      quality: quality?.ok ?? null,
      ...(quality && !quality.ok ? { qualityDetail: quality.detail } : {}),
      ...(prepared.failure ? { failure: prepared.failure } : {}),
    };
    for (const row of [baselineRow, speculationRow]) {
      runs.push(row);
      writeFileSync(`${outDir}/run-${runs.length}.json`, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
    }
  }
}

const summarise = (arm: string, fact: boolean) => {
  const rows = runs.filter((row) => row.arm === arm && row.fact === fact);
  const total = (key: string) =>
    rows.reduce((sum, row) => sum + Number((row as Record<string, unknown>)[key] ?? 0), 0);
  return {
    arm,
    fact,
    runs: rows.length,
    tokens: total("tokens"),
    workMs: total("workMs"),
    postFactMs: total("postFactMs"),
    quality: rows.map((row) => row.quality),
  };
};
const aggregate = [true, false].flatMap((fact) => [
  summarise("baseline", fact),
  summarise("speculation", fact),
]);
writeFileSync(
  `${outDir}/aggregate.json`,
  `${JSON.stringify({ provider, model, aggregate }, null, 2)}\n`,
);
console.log("AGGREGATE");
console.log(JSON.stringify(aggregate, null, 2));
