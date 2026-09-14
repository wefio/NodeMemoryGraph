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
 * Where a mutant says where it applies:
 *
 *   - `ast: { within: "<member>" }` (or `ast: { call, argCount }`) locates the site through the syntax
 *     tree. Use this in any file that is still being edited. It survives reformatting, and it refuses
 *     when the code it guards has moved out of the member it belongs to - a move that a byte anchor
 *     would have followed silently.
 *   - a bare `from`/`to` pair matches bytes, then the same bytes with whitespace normalized. It is for
 *     settled files, where the anchor is cheap and the code is not moving. A re-taken anchor is
 *     printed, so a reflow never retires a tooth without saying so.
 *
 * Usage:
 *   npm run mutation:teeth -- [--targets=<path>[,<path>...]] [--json <out>]
 * Exit status is non-zero if the clean run fails, any mutant survives, any anchor is missing in a
 * named target, or a restore is not byte-identical.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import ts from "typescript";

import { writeJsonAtomic } from "./parts/fs.ts";

interface Mutant {
  /** What the wrong version does, in the words of the rule it breaks. */
  readonly name: string;
  /** The exact bytes to replace. Omitted when `ast` locates the site instead. */
  readonly from?: string;
  /** A format-independent locator: find the site by syntax tree, not by text. Prettier reflows these
   *  files on every commit, and a text anchor silently stops applying the first time that happens. */
  readonly ast?: {
    /** The method or function whose body is searched. The structurally scoped form: it survives
     *  reflow, and it refuses when the code it guards has moved out of the member it belongs to. */
    readonly within?: string;
    /** The call or constructor to locate, by its callee name. */
    readonly call?: string;
    /** How many arguments it takes, when the count is what tells the sites apart. */
    readonly argCount?: number;
  };
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
      "tests/core/store-transaction-port.test.ts",
      "tests/core/store-readonly-open.test.ts",
    ],
    mutants: [
      {
        // The store owns the boundary: a write reached inside a transition without its port must be
        // refused rather than become a second BEGIN.
        name: "nested-write-transaction-is-allowed",
        ast: { within: "writeTransaction" },
        from: '    if (this.openTransaction)\n      throw new Error("a write transaction is already open: join it with the port it issued");',
        to: '    if (this.openTransaction && false)\n      throw new Error("a write transaction is already open: join it with the port it issued");',
        expect: "a write entry reached inside a transition without a port is refused, not nested",
      },
      {
        // A failure the caller swallows still forbids the commit: nothing may be written up to the
        // failure and then kept by a normal return value.
        name: "swallowed-failure-still-commits",
        ast: { within: "withPort" },
        from: "      state.rollbackOnly = true;",
        to: "      void state.rollbackOnly;",
        expect: "a failure the caller swallows still forbids the commit",
      },
      {
        // The mechanical invariant: a hand-rolled BEGIN anywhere in the store makes a second
        // boundary possible, and behaviour tests would not notice a path that still works.
        name: "a-method-opens-its-own-transaction",
        ast: { within: "removeMemoryFromChain" },
        from: "    return this.writeTransaction(() => {",
        to: '    this.db.exec("BEGIN IMMEDIATE");\n    return this.writeTransaction(() => {',
        expect: "the store runs its transaction boundary in exactly one place",
      },
      {
        name: "stale-claim-may-deliver-again",
        ast: { within: "claimTaskBoardEntry" },
        from: "    if (!renewed) {",
        to: "    if (false && !renewed) {",
        expect: "renewing your own live claim does not start a new attempt",
      },
      {
        name: "deliverer-may-judge-its-own-work",
        ast: { within: "judgeTaskBoardEntry" },
        from: "    if (existing.deliveredBy === input.agentId) {",
        to: "    if (false && existing.deliveredBy === input.agentId) {",
        expect: "the deliverer cannot judge its own deliverable",
      },
      {
        name: "prune-ignores-retention",
        ast: { within: "pruneExpiredTaskBoardEntries" },
        from: "            `DELETE FROM task_board_entries WHERE task_id = ? AND expires_at <= ?\n               AND id NOT IN (SELECT entry_id FROM task_board_retentions)`,",
        to: "            `DELETE FROM task_board_entries WHERE task_id = ? AND expires_at <= ?`,",
        expect: "a retained entry, its delivery and its acknowledgement survive the prune",
      },
      {
        name: "bounded-pin-never-expires",
        ast: { within: "expireStaleRetentions" },
        from: '        "DELETE FROM task_board_retentions WHERE retained_until IS NOT NULL AND retained_until <= ?",',
        to: '        "DELETE FROM task_board_retentions WHERE 0",',
        expect: "a bounded pin stops pinning when its bound passes",
      },
    ],
  },
  {
    target: "src/integration/ooo-board.ts",
    suites: [
      "evals/ooo-execution/patch-cycle.test.ts",
      "tests/integration/ooo-run-namespace.test.ts",
      "tests/integration/ooo-task-tables.test.ts",
      "tests/integration/ooo-transition-atomicity.test.ts",
    ],
    mutants: [
      {
        // The claim is the write that would corrupt a neighbour run: the same task id exists in
        // every run, so a claim that is not scoped by run claims somebody else's row too.
        name: "claim-is-not-scoped-to-its-run",
        ast: { within: "claim" },
        from: '          "UPDATE ooo_probe_facts SET attempt=?, owner=?, claim_time=? WHERE run_id=? AND id=?",',
        to: '          "UPDATE ooo_probe_facts SET attempt=?, owner=?, claim_time=? WHERE ? IS NOT NULL AND id=?",',
        expect:
          "two runs in one store do not collide, do not see each other, and cancel separately",
      },
      {
        // The composed write must join the transition it is called in: a publication that opens its
        // own boundary commits even when the transition around it fails.
        name: "round-publication-opens-its-own-transaction",
        ast: { within: "publish" },
        from: "      },\n      port,\n    ).id;",
        to: "      },\n    ).id;",
        expect: "the round's own publication rolls back with the transition that made it",
      },
      {
        // The cache exists to be recomputable. A rebuild that returns without writing is the
        // difference between "the sources decide" and "the schema says so".
        name: "derived-rebuild-is-a-no-op",
        ast: { within: "refreshDerived" },
        from: "        this.putInputDigest(\n          row.id,\n          row.attempt >= 1 ? (frozen?.digest ?? this.inputDigest(row)) : null,\n        );",
        to: "        void row.id;",
        expect: "deleting the derived cache and rebuilding it yields the same view",
      },
      {
        name: "round-releases-dependents-on-delivered-bytes",
        ast: { within: "acceptedArtifacts" },
        from: "          verdict: recorded?.verdict ?? null,",
        to: '          verdict: "accepted",',
        expect:
          "an outside rejection withdraws the release of a dependent, and the round fails closed",
      },
      {
        name: "verdict-lookup-not-bound-to-the-artifact",
        ast: { within: "acceptedArtifacts" },
        from: "      const recorded = verdictOf.get(this.channel, digest) as unknown as",
        to: '      const recorded = verdictOf.get(this.channel, "%") as unknown as',
        expect: "the board verdict is what accepts an artifact, not the round's own column",
      },
      {
        name: "selection-ignores-a-withdrawn-acceptance",
        ast: { within: "next" },
        from: "    const schedulable = rows.filter(\n      (row) => !this.delivered(row) || Object.hasOwn(accepted, row.id),\n    );",
        to: "    const schedulable = rows;",
        expect:
          "an outside rejection withdraws the release of a dependent, and the round fails closed",
      },
      {
        name: "round-does-not-pin-what-it-references",
        ast: { within: "publishReady" },
        from: '      this.retainTaskBoardEntry({\n        taskId: this.channel,\n        entryId,\n        owner: RETENTION_OWNER,\n        reason: `round ${this.runId ?? "initial"} handoff for ${row.id}`,\n        now: new Date(this.now).toISOString(),\n      });',
        to: "      void entryId;",
        expect:
          "acceptance survives the entry's own TTL, because the round retains what it references",
      },
      {
        name: "round-never-releases-its-pin",
        ast: { within: "fenceRow" },
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
  {
    // The evidence drivers are not covered by tsc or eslint, so their own smoke test is the only
    // thing that fails when one of them is edited wrongly. These two mutants are the defects the
    // drivers were written around: the worker read only one reporter's count format and reported
    // 0/0 for a passing run, and a deliverer could judge its own work.
    target: "evals/ooo-execution/board-worker.ts",
    suites: ["tests/integration/ooo-evidence-drivers.test.ts"],
    mutants: [
      {
        name: "worker-reads-only-one-reporter-shape",
        from: '    const spec = new RegExp(`^\u2139 ${label} (\\\\d+)$`, "m").exec(body);',
        to: "    const spec = null;",
        expect: "the worker claims, runs the named suite and delivers its digest",
      },
    ],
  },
  {
    target: "evals/ooo-execution/board-judge.ts",
    suites: ["tests/integration/ooo-evidence-drivers.test.ts"],
    mutants: [
      {
        name: "judge-may-judge-its-own-delivery",
        from: "  if (entry.deliveredBy === agentId) {",
        to: "  if (false && entry.deliveredBy === agentId) {",
        expect: "the board drivers run the protocol end to end on a scratch store",
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

/** Where a mutant applies: by syntax when it says so, by bytes otherwise.
 *
 *  A text anchor is tried exactly first, then with whitespace normalized, because the commit hook
 *  runs prettier and reflowing a file must not quietly retire a tooth. A site that cannot be located
 *  is a failure: "not applicable" is reserved for a target file that is not on this branch. */
/** Whitespace-normalized text search: exact bytes first, then reflowed form.
 *
 *  The commit hook runs prettier, so a reflowed anchor must not retire a tooth. More than one match
 *  is still refused, because replacing the first would leave the rule intact somewhere else. */
function matchText(
  haystack: string,
  anchor: string,
): { start: number; end: number; retaken: boolean } | { reason: string } {
  const occurrences = haystack.split(anchor).length - 1;
  if (occurrences === 1) {
    const start = haystack.indexOf(anchor);
    return { start, end: start + anchor.length, retaken: false };
  }
  if (occurrences > 1)
    return { reason: `marker occurs ${occurrences} times, refusing to claim a check` };
  // Built without a regex literal: one containing `${` confuses Node's type-stripping parser.
  const special = ".*+?^$()[]{}|\\";
  const escaped = anchor
    .trim()
    .split(/\s+/u)
    .map((part) => [...part].map((ch) => (special.includes(ch) ? "\\" + ch : ch)).join(""))
    .join("\s+");
  const matches = [...haystack.matchAll(new RegExp(escaped, "gu"))];
  if (matches.length !== 1)
    return {
      reason: `marker not found (${matches.length} matches once whitespace is normalized), refusing to claim a check`,
    };
  const match = matches[0]!;
  return { start: match.index, end: match.index + match[0].length, retaken: true };
}

/** Where a mutant applies: by syntax tree when it says so, by bytes otherwise.
 *
 *  A site that cannot be located is a failure, not an "not applicable": that verdict is reserved for
 *  a target file that is not on this branch at all. Files that are still being edited should carry an
 *  `ast` locator, because a text anchor in them retires itself the first time the formatter runs. */
function locate(
  text: string,
  mutant: Mutant,
): { start: number; end: number; retaken: boolean } | { reason: string } {
  if (mutant.ast) {
    const source = ts.createSourceFile("mutant.ts", text, ts.ScriptTarget.Latest, true);
    if (mutant.ast.within !== undefined) {
      const members: ts.Node[] = [];
      const visit = (node: ts.Node): void => {
        const named =
          (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
          node.name?.getText(source) === mutant.ast!.within;
        if (named) members.push(node);
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (members.length !== 1)
        return {
          reason: `ast scope ${mutant.ast.within} matched ${members.length} members, refusing to claim a check`,
        };
      const member = members[0]!;
      if (mutant.from === undefined)
        return { reason: "an ast scope needs a from anchor to find inside it" };
      const inner = matchText(member.getText(source), mutant.from);
      if ("reason" in inner) return { reason: `inside ${mutant.ast.within}: ${inner.reason}` };
      const offset = member.getStart(source);
      return { start: offset + inner.start, end: offset + inner.end, retaken: inner.retaken };
    }
    const found: ts.Node[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const args = node.arguments?.length ?? 0;
        if (
          node.expression.getText(source) === mutant.ast!.call &&
          (mutant.ast!.argCount === undefined || args === mutant.ast!.argCount)
        )
          found.push(node);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    if (found.length !== 1)
      return {
        reason: `ast locator ${mutant.ast.call} matched ${found.length} sites, refusing to claim a check`,
      };
    return { start: found[0]!.getStart(source), end: found[0]!.getEnd(), retaken: false };
  }
  if (mutant.from === undefined)
    return { reason: "mutant has neither an ast locator nor a from anchor" };
  const found = matchText(text, mutant.from);
  if ("reason" in found) return found;
  if (found.retaken)
    process.stdout.write(
      `  re-taken anchor: ${mutant.name} (formatting reflowed it; ${String(found.end - found.start)} bytes)
`,
    );
  return found;
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
    const site = locate(text, mutant);
    if ("reason" in site) {
      // A site that cannot be located is a failure even in the default list: the file is on this
      // branch, so its code moved or was reflowed past recognition, and the tooth did not run.
      const reason = `${target} / mutant ${mutant.name}: ${site.reason}`;
      problems.push(`  ${reason}`);
      mutantOutcomes.push({
        name: mutant.name,
        applicable: false,
        caught: false,
        note: site.reason,
      });
      continue;
    }
    writeFileSync(target, text.slice(0, site.start) + mutant.to + text.slice(site.end));
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
