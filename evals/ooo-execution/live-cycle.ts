// Explicit --live required. Real model calls, real git-worktree candidate checks,
// real background check concurrent with B. Nothing in the working tree is modified.
// Requires PI_PROVIDER and PI_MODEL; use the provider the user authorized.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCycle, type Requirement } from "./cycle.ts";
import { mutate, type Mutation } from "./mutation.ts";
import { RoundLog } from "./round-log.ts";
import { verifyCandidate } from "./candidate.ts";
import {
  executePiPatch,
  type CheckTool,
  type PushbackSpec,
} from "../../.pi/extensions/nmg/ooo-execution.ts";

const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;
if (!process.argv.includes("--live"))
  throw new Error("pass --live explicitly: this calls the configured model");
if (!provider || !model) throw new Error("Set PI_PROVIDER and PI_MODEL explicitly");

const repository = process.cwd();
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Round-frozen baseline: every untracked OoO file the fixed check needs. */
const baselinePaths = [
  "src/integration/ooo-execution.ts",
  "src/integration/ooo-patch.ts",
  "src/integration/ooo-check.ts",
  "evals/ooo-execution/board-admission.ts",
  "evals/ooo-execution/patch-verifier.ts",
  "evals/ooo-execution/check-events.test.ts",
  "evals/ooo-execution/patch-cycle.test.ts",
];
const baseline = Object.fromEntries(baselinePaths.map((path) => [path, read(path)]));
const checks = [
  {
    label: "protocol-regression",
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      "--test",
      "evals/ooo-execution/check-events.test.ts",
      "evals/ooo-execution/patch-cycle.test.ts",
    ],
  },
];

// Only the waiting task's cases; B is in proven-gap mode, which replaces the token
// rule with "passes intact and kills a declared mutant".
const cases = {
  A: [{ name: "check-identity", token: "samecheck rejects a ticket whose attempt differs" }],
};

/** Host-owned mutants of the editable implementation. Each is proven to survive the
 *  frozen suite before the round starts (cycle.ts refuses the round otherwise), so
 *  "this fault goes undetected" is evidence rather than an assumption. */
const mutants: readonly Mutation[] = [
  {
    id: "reopen-keeps-attempt",
    path: "evals/ooo-execution/board-admission.ts",
    from: "SET artifact=NULL, attempt=attempt+1, owner=NULL",
    to: "SET artifact=NULL, attempt=attempt, owner=NULL",
  },
];

/** The worker gets exactly the round's own check, bounded, so it can verify its own
 *  patch. Every earlier round failed on a test the worker could not run. */
const checkTool: CheckTool = {
  label: "run_check",
  maxRuns: 4,
  run: async (files) => {
    const result = await verifyCandidate({
      repository,
      revision,
      files: { ...baseline, ...Object.fromEntries(files.map((file) => [file.path, file.content])) },
      checks,
    });
    const failed = result.outcomes.find((outcome) => outcome.status !== "passed");
    return {
      verdict: result.verdict,
      log:
        result.outcomes.map((outcome) => `${outcome.label}=${outcome.status}`).join(", ") +
        (failed?.log ? ` | ${failed.log.slice(-2_000)}` : ""),
    };
  },
};

/** What the composition task declares it needs from its dependencies. The host
 *  evaluates these mechanically; the worker may also push back mid-attempt when what
 *  it received cannot satisfy one of them. */
const requirements: readonly Requirement[] = [
  { kind: "mutant-killed", task: "B", id: "reopen-keeps-attempt" },
];
const pushback: PushbackSpec = {
  requirements: requirements.map((requirement) => ({
    task: requirement.task,
    requirement:
      requirement.kind === "mutant-killed"
        ? `${requirement.task} kills ${requirement.id}`
        : `${requirement.task} satisfies ${requirement.kind}`,
  })),
};

const runs: number[] = [];

const result = await runCycle({
  repository,
  revision,
  baseline,
  checks,
  noChangeCases: cases,
  // The round records itself as it runs, so it can be replayed later without a model:
  // replay re-checks the recorded answers through the host and re-derives every verdict.
  roundLog: new RoundLog(".nmg/ooo-live/round.jsonl"),
  mutations: { B: mutants },
  requires: { C: requirements },
  maxReopens: 1,
  // The whole baseline is re-sent on every model turn. Each task reads only the files
  // its acceptance rule can point at (the implementation under test and the tests that
  // exercise it); the large harness files stay frozen and hidden, and the host still
  // verifies against all of them.
  visible: {
    A: [
      "src/integration/ooo-check.ts",
      "evals/ooo-execution/board-admission.ts",
      "evals/ooo-execution/patch-verifier.ts",
      "evals/ooo-execution/check-events.test.ts",
      "evals/ooo-execution/patch-cycle.test.ts",
    ],
    B: [
      "src/integration/ooo-check.ts",
      "evals/ooo-execution/board-admission.ts",
      "evals/ooo-execution/patch-verifier.ts",
      "evals/ooo-execution/check-events.test.ts",
      "evals/ooo-execution/patch-cycle.test.ts",
    ],
    C: [
      "src/integration/ooo-check.ts",
      "evals/ooo-execution/board-admission.ts",
      "evals/ooo-execution/patch-verifier.ts",
      "evals/ooo-execution/check-events.test.ts",
      "evals/ooo-execution/patch-cycle.test.ts",
    ],
  },
  // Only the kind each task's rule can admit. B must return files (a proven gap cannot
  // be answered with prose or with a promotion), C must promote the composed candidate.
  admitted: {
    A: ["no-change-needed", "cannot-complete"],
    B: ["cannot-complete"],
    C: ["promote-candidate", "cannot-complete"],
  },
  aEditable: ["src/integration/ooo-check.ts"],
  bEditable: ["evals/ooo-execution/check-events.test.ts"],
  budget: { perFile: 24_000, output: 48_000 },
  limits: { turns: 10, reads: 6, timeoutMs: 180_000 },
  aInstruction:
    "You are the repair task of an out-of-order development round. The editable file owns the " +
    "external-check protocol: host-issued check identity, terminal evidence, fencing and expiry. " +
    "A fixed regression check has run against the frozen revision; its outcome is stated below. " +
    "If it exposed a real defect inside your editable file, return a patch fixing exactly that. " +
    "If nothing in your editable file is at fault, return a no-change conclusion citing the exact " +
    "existing test title that already establishes check identity. Do not change behavior the check " +
    "does not justify.",
  bInstruction:
    "You are the independent regression task of an out-of-order development round. Frozen here are " +
    "the check protocol, the coordination board and the tests that exercise them. The host has " +
    "already proved, by mutation, that the frozen suite does not detect the faults listed below; " +
    "each is stated as the exact code change that introduces it. Add regression tests to the " +
    "editable test file so that the suite now detects them. The host accepts your patch only when " +
    "it passes on the intact implementation and fails on at least one listed mutation; a test that " +
    "passes in both cases proves nothing and is rejected. A no-change conclusion is also rejected, " +
    "because the host's own evidence already shows a gap. Change only that test file.",
  worker: async (_taskId, frozen) => {
    const run = await executePiPatch(frozen, provider, model, { check: checkTool, pushback });
    runs.push(run.checks);
    const metrics = {
      tokens: run.tokens,
      turns: run.turns,
      checks: run.checks,
      cacheRead: run.cacheRead,
      cacheWrite: run.cacheWrite,
    };
    if (run.pushback) return { artifact: "", pushback: run.pushback, metrics };
    return { artifact: run.artifact, metrics };
  },
});

const report = {
  finishedAt: new Date().toISOString(),
  provider,
  model,
  revision,
  checks: checks.map((check) => check.label),
  caseRules: cases,
  mutants: mutants.map((mutation) => ({
    id: mutation.id,
    killed: result.killed.B?.includes(mutation.id) ?? false,
    survived: result.survived.B?.includes(mutation.id) ?? false,
  })),
  verdicts: result.verdicts,
  composed: result.composed,
  measurements: result.measurements,
  // How often the worker verified its own proposal before answering.
  workerCheckRuns: runs,
  timeline: result.timeline,
  rejections: result.rejections.map((entry) => ({
    ...entry,
    artifact: entry.artifact.slice(0, 600),
  })),
  submissions: Object.fromEntries(
    Object.entries(result.submissions).map(([task, submission]) => [
      task,
      submission.kind === "patch"
        ? {
            kind: "patch",
            files: Object.keys(submission.files).filter(
              (path) => baseline[path] !== submission.files[path],
            ),
          }
        : {
            kind: "conclusion",
            conclusion: submission.conclusion,
            citations: submission.citations,
          },
    ]),
  ),
};
mkdirSync(".nmg/ooo-live", { recursive: true });
// An accepted candidate is the round's product: keep the changed files, otherwise a
// useful result exists only inside the process that produced it. The changed files are
// also written out as real files, so promotion is a reviewable copy and a stale
// hand-written "candidate" can never be mistaken for a round's product.
for (const [task, submission] of Object.entries(result.submissions)) {
  if (submission.kind !== "patch") continue;
  const changed = Object.fromEntries(
    Object.entries(submission.files).filter(([path, text]) => baseline[path] !== text),
  );
  writeFileSync(
    `.nmg/ooo-live/accepted-${task}.json`,
    JSON.stringify({ task, changed, mutantKills: result.killed[task] ?? [] }, null, 2) + "\n",
  );
  for (const [path, text] of Object.entries(changed)) {
    const target = join(".nmg/ooo-live/candidate", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}
// The mutated text is kept so a later reader can reproduce the round's premise.
writeFileSync(
  ".nmg/ooo-live/mutants.json",
  JSON.stringify(
    mutants.map((mutation) => ({
      ...mutation,
      mutated: mutate(baseline, mutation)[mutation.path],
    })),
    null,
    2,
  ) + "\n",
);
writeFileSync(".nmg/ooo-live/cycle.json", JSON.stringify(report, null, 2) + "\n");
// Rejected artifacts are kept in full (still bounded), because the reason a round
// failed is often visible only in the text the contract refused.
writeFileSync(
  ".nmg/ooo-live/rejections.json",
  JSON.stringify(
    result.rejections.map((entry) => ({ ...entry, caseRules: cases })),
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (result.verdicts.A !== "accepted" || result.verdicts.B !== "accepted")
  throw new Error("round did not accept A and B");
