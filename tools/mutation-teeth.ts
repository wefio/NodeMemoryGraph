/**
 * Mutation teeth for the restricted out-of-order execution slices.
 *
 * A test can pass for the wrong reason: the rule it claims to protect may be dead code, or the
 * assertion may hold for a reason other than the one written down. Each mutant below replaces one
 * load-bearing line with a plausible-but-wrong version; the suite must then fail, and the *expected
 * test* must be the one that fails. Three outcomes per target, not two:
 *
 *   1. the clean tree passes the target's suites;
 *   2. every mutant fails them, and the named test is what caught it;
 *   3. the target file is restored byte-identically.
 *
 * A mutant that fails nothing is a decoration, not a check. Two failure modes have been observed
 * here and both are treated as failures rather than as passes:
 *
 *   - a **stale anchor**: refactoring moves the line a mutant replaces, so the mutant silently
 *     stops applying (a marker that is absent, or present more than once, is refused rather than
 *     half-applied);
 *   - a **stale suite list**: the mutant is real but the suites it runs against do not include the
 *     file holding the test that would catch it.
 *
 * A target whose mutants belong to code that is not on the checked-out branch cannot be exercised
 * here. Named targets (`--targets`) are a claim that they can be, so a missing anchor or suite is
 * then a failure; in the default list the same condition is reported as *not applicable* and is
 * never counted as caught. `--targets` therefore names what was actually run, so each branch's
 * evidence stays reproducible.
 *
 * Usage:
 *   npm run mutation:teeth -- [--targets=<path>[,<path>...]] [--json <out>]
 * Exit status is non-zero if the clean run fails, any mutant survives, any anchor is missing in a
 * named target, or a restore is not byte-identical.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { writeJsonAtomic } from "./parts/fs.ts";

interface Mutant {
  /** What the wrong version does, in the words of the rule it breaks. */
  readonly name: string;
  readonly from: string;
  readonly to: string;
  /** The test that must be the one to fail. */
  readonly expect: string;
}

interface Target {
  readonly target: string;
  readonly suites: readonly string[];
  readonly mutants: readonly Mutant[];
}

const TARGETS: readonly Target[] = [
  {
    target: "src/integration/task-semantics.ts",
    suites: [
      "tests/integration/task-semantics.test.ts",
      "tests/integration/task-semantics-cases.test.ts",
    ],
    mutants: [
      {
        name: "any-verdict-counts-as-accepted",
        from: '  if (fact.verdict !== "accepted") return false;',
        to: "  if (fact.verdict === null) return false;",
        expect: "acceptedFact is the single rule, and the view adapter does not grow its own",
      },
      {
        name: "read-or-write-path-may-leave-the-frozen-files",
        from: "      if (!usable.has(path)) {",
        to: "      if (false && !usable.has(path)) {",
        expect: "refuses a read or write path outside the frozen files",
      },
      {
        name: "spec-level-alias-is-dropped",
        from: "  for (const key of unknownKeys(spec, SPEC_FIELDS)) {",
        to: "  for (const key of [] as string[]) {",
        expect: "refuses the aliases that would turn a byte budget into a token claim",
      },
      {
        name: "budget-inner-alias-is-dropped",
        from: "  for (const key of unknownBudget) {",
        to: "  for (const key of [] as string[]) {",
        expect: "refuses an unknown key inside budget or limits, and a range above the maximum",
      },
      {
        name: "over-maximum-budget-is-accepted",
        from: "  if (spec.budget && !unknownBudget.length && !within(spec.budget, MAX_PATCH_BUDGET)) {",
        to: "  if (false) {",
        expect: "refuses an unknown key inside budget or limits, and a range above the maximum",
      },
      {
        name: "view-adapter-accepts-bytes",
        from: "  const recorded = facts.verdicts?.[unit.id];",
        to: "  return Boolean(facts.artifacts?.[unit.id]);",
        expect: "acceptedFact is the single rule, and the view adapter does not grow its own",
      },
      {
        name: "assumption-may-carry-a-dependency",
        from: '    } else if (typeof task === "string" && !dependencies.includes(task)) {',
        to: "    } else if (false) {",
        expect:
          "case 2: a lost obligation or a widened permission is refused, and an assumption cannot stand in for a dependency",
      },
    ],
  },
  {
    target: "src/core/store/base.ts",
    suites: [
      "tests/core/task-board-retention.test.ts",
      "tests/core/task-board-deliverable.test.ts",
    ],
    mutants: [
      {
        name: "stale-claim-may-deliver-again",
        from: "    if (!renewed) {",
        to: "    if (false && !renewed) {",
        expect: "renewing your own live claim does not start a new attempt",
      },
      {
        name: "deliverer-may-judge-its-own-work",
        from: "    if (existing.deliveredBy === input.agentId) {",
        to: "    if (false && existing.deliveredBy === input.agentId) {",
        expect: "the deliverer cannot judge its own deliverable",
      },
      {
        name: "prune-ignores-retention",
        from: "            `DELETE FROM task_board_entries WHERE task_id = ? AND expires_at <= ?\n               AND id NOT IN (SELECT entry_id FROM task_board_retentions)`,",
        to: "            `DELETE FROM task_board_entries WHERE task_id = ? AND expires_at <= ?`,",
        expect: "a retained entry, its delivery and its acknowledgement survive the prune",
      },
      {
        name: "bounded-pin-never-expires",
        from: '        "DELETE FROM task_board_retentions WHERE retained_until IS NOT NULL AND retained_until <= ?",',
        to: '        "DELETE FROM task_board_retentions WHERE 0",',
        expect: "a bounded pin stops pinning when its bound passes",
      },
    ],
  },
  {
    target: "src/integration/ooo-board.ts",
    suites: ["evals/ooo-execution/patch-cycle.test.ts"],
    mutants: [
      {
        name: "round-releases-dependents-on-delivered-bytes",
        from: "          verdict: recorded?.verdict ?? null,",
        to: '          verdict: "accepted",',
        expect:
          "an outside rejection withdraws the release of a dependent, and the round fails closed",
      },
      {
        name: "acceptance-ignores-the-board-verdict",
        from: "          verdict: row.verdict === null ? null : String(row.verdict),",
        to: '          verdict: "accepted",',
        expect: "the board verdict is what accepts an artifact, not the round's own column",
      },
      {
        name: "selection-ignores-a-withdrawn-acceptance",
        from: "    const schedulable = rows.filter(\n      (row) => !this.delivered(row) || Object.hasOwn(accepted, row.id),\n    );",
        to: "    const schedulable = rows;",
        expect:
          "an outside rejection withdraws the release of a dependent, and the round fails closed",
      },
      {
        name: "round-does-not-pin-what-it-references",
        from: '      this.retainTaskBoardEntry({\n        taskId: channel,\n        entryId,\n        owner: RETENTION_OWNER,\n        reason: `round ${this.runId ?? "initial"} handoff for ${row.id}`,\n        now: new Date(this.now).toISOString(),\n      });',
        to: "      void entryId;",
        expect:
          "acceptance survives the entry's own TTL, because the round retains what it references",
      },
      {
        name: "round-never-releases-its-pin",
        from: "    // The artifact is being cleared, so the round no longer relies on this entry's\n    // verdict: the pins go with the value they protected.\n    this.releaseRowRetention(row);",
        to: "    // The artifact is being cleared, so the round no longer relies on this entry's\n    // verdict: the pins go with the value they protected.",
        expect: "cancelling a round releases the pins it held, so nothing it referenced leaks",
      },
    ],
  },
  {
    target: "src/integration/task-semantics-model.ts",
    suites: ["tests/integration/task-semantics-model.test.ts"],
    mutants: [
      {
        name: "ordered-mode-becomes-any-topological-order",
        from: '  if (mode === "ordered") return [[...ids]];',
        to: '  if (mode === "ordered" && !ids.length) return [[...ids]];',
        expect: "the ordered mode is the declared plan order and nothing else",
      },
      {
        name: "fusion-rollback-not-counted",
        from: "      rollbacks += 1;\n      retries += 1;",
        to: "      retries += 1;",
        expect: "a dependency that is not accepted makes fusion pay a rollback and a retry",
      },
      {
        name: "acceptance-closure-dropped",
        from: "        own(unit.id) && unit.inputs.dependencies.every((dependency) => accepted.has(dependency));",
        to: "        own(unit.id);",
        expect: "a dependency that is not accepted makes fusion pay a rollback and a retry",
      },
    ],
  },
];

interface MutantOutcome {
  readonly name: string;
  /** False when this mutant replaces code that is not in this checkout. */
  readonly applicable: boolean;
  readonly caught: boolean;
  readonly note?: string;
}

interface Outcome {
  readonly target: string;
  readonly cleanRunPasses: boolean;
  readonly restoredByteIdentically: boolean;
  /** Suites this target should run that this checkout does not contain. */
  readonly absentSuites?: readonly string[];
  readonly mutants: readonly MutantOutcome[];
}

function runSuites(suites: readonly string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--test", "--test-concurrency=1", ...suites],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, out };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

const { values } = parseArgs({
  options: { targets: { type: "string", multiple: true }, json: { type: "string" } },
});
const requested = (values.targets ?? []).flatMap((entry) => entry.split(",")).filter(Boolean);
if (values.targets && requested.length === 0)
  throw new Error("--targets was given but named no target");
const unknown = requested.filter((name) => !TARGETS.some((entry) => entry.target === name));
if (unknown.length > 0) throw new Error(`unknown target: ${unknown.join(", ")}`);
const selected = requested.length
  ? TARGETS.filter((entry) => requested.includes(entry.target))
  : TARGETS;
/** Naming a target is a claim that it can be exercised here; the default list is not. */
const strict = requested.length > 0;

const outcomes: Outcome[] = [];
const problems: string[] = [];
const skipped: string[] = [];
for (const { target, suites, mutants } of selected) {
  const present = suites.filter((suite) => existsSync(suite));
  const absent = suites.filter((suite) => !existsSync(suite));
  if (absent.length > 0) {
    const reason = `${target}: suite not present in this checkout: ${absent.join(", ")}`;
    if (strict) problems.push(reason);
    else skipped.push(reason);
  }
  if (present.length === 0) {
    outcomes.push({
      target,
      cleanRunPasses: false,
      restoredByteIdentically: true,
      absentSuites: absent,
      mutants: mutants.map((mutant) => ({
        name: mutant.name,
        applicable: false,
        caught: false,
        note: "no suite present",
      })),
    });
    continue;
  }
  const original = readFileSync(target);
  const clean = runSuites(present);
  if (!clean.ok) problems.push(`${target}: clean run failed, the harness proves nothing`);
  const mutantOutcomes: MutantOutcome[] = [];
  for (const mutant of mutants) {
    const text = original.toString("utf8");
    // The marker must occur exactly once: zero occurrences means the code moved, and more than
    // one means replacing the first would leave the rule intact somewhere else.
    const hits = text.split(mutant.from).length - 1;
    if (hits !== 1) {
      const reason = `${target} / mutant ${mutant.name}: marker occurs ${hits} times, refusing to claim a check`;
      if (strict) problems.push(`  ${reason}`);
      else skipped.push(reason);
      mutantOutcomes.push({
        name: mutant.name,
        applicable: false,
        caught: false,
        note: `marker occurs ${hits} times`,
      });
      continue;
    }
    writeFileSync(target, text.replace(mutant.from, mutant.to));
    const result = runSuites(present);
    const caught = !result.ok && result.out.includes(mutant.expect);
    mutantOutcomes.push(
      caught
        ? { name: mutant.name, applicable: true, caught }
        : { name: mutant.name, applicable: true, caught, note: "survived" },
    );
    if (!caught) {
      const observed = result.out
        .split("\n")
        .filter((line) => line.startsWith("✖ ") || line.includes("Error"))
        .slice(0, 3);
      problems.push(
        `  mutant ${mutant.name}: NOT caught by "${mutant.expect}" (suite passed: ${result.ok}; observed: ${
          observed.join(" | ") || "no failure reported"
        })`,
      );
    }
  }
  writeFileSync(target, original);
  const restored = Buffer.compare(original, readFileSync(target)) === 0;
  if (!restored) problems.push(`${target}: restore is not byte-identical`);
  outcomes.push({
    target,
    cleanRunPasses: clean.ok,
    restoredByteIdentically: restored,
    ...(absent.length > 0 ? { absentSuites: absent } : {}),
    mutants: mutantOutcomes,
  });
}

const applicable = outcomes.reduce(
  (total, outcome) => total + outcome.mutants.filter((mutant) => mutant.applicable).length,
  0,
);
const caught = outcomes.reduce(
  (total, outcome) => total + outcome.mutants.filter((mutant) => mutant.caught).length,
  0,
);
const say = (line: string) => process.stdout.write(`${line}\n`);
say(
  `targets: ${outcomes.length} of ${TARGETS.length} (${selected.map((entry) => entry.target).join(", ")})`,
);
say(`mutants: ${caught} of ${applicable} caught by the named test`);
say(
  `restored byte-identically: ${outcomes.filter((outcome) => outcome.restoredByteIdentically).length} of ${outcomes.length}`,
);
if (skipped.length > 0) {
  say(`not applicable in this checkout: ${skipped.length} (run with --targets to require them)`);
  for (const reason of skipped) say(`  ${reason}`);
}
say(`measuredAt: ${new Date().toISOString()}`);
for (const problem of problems) process.stderr.write(`${problem}\n`);
if (values.json)
  writeJsonAtomic(values.json, {
    targets: outcomes,
    mutantsApplicable: applicable,
    mutantsCaught: caught,
    notApplicable: skipped,
    problems,
    measuredAt: new Date().toISOString(),
  });
process.exit(problems.length > 0 ? 1 : 0);
