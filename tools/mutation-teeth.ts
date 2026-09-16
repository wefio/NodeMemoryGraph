/**
 * Mutation teeth for the restricted out-of-order execution slices.
 *
 * A test can pass for the wrong reason: the rule it claims to protect may be dead code, or the
 * assertion may hold for a reason other than the one written down. Each mutant below replaces one
 * load-bearing line with a plausible-but-wrong version; the suite must then fail, and the *expected
 *
 * Two rules the config learned the hard way. `expect` is the NAME of the test that must fail -
 * prose there makes a real catch read as "NOT caught". The `ast` locator is indentation-sensitive,
 * so an anchor whose leading spaces no longer match the file is a stale anchor to be fixed, not a
 * cosmetic difference; and a site that cannot be located is a failure, never a claimed check.
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
      "tests/core/store/task-runs.test.ts",
      "tests/integration/ooo-managed-fence.test.ts",
    ],
    mutants: [
      {
        // The handle, not a PRAGMA, is what makes this read-only: restoring writability must fail the test.
        name: "the-read-only-factory-opens-a-writable-handle",
        ast: { call: "DatabaseSync", argCount: 2 },
        to: "new DatabaseSync(databasePath)",
        expect: "a read-only open neither creates, migrates nor writes",
      },
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
        // The claim CAS is the whole of the fence: a reader who cannot take a live claim must
        // lose it, and the condition that says so is the only thing between two readers and the
        // same work.
        name: "a-live-claim-can-be-taken-by-another-agent",
        ast: { within: "claimTaskBoardEntry" },
        from: "           AND (\n             (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)\n             OR claimed_by = ?\n           )`,",
        to: "           AND (\n             (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)\n             OR ? IS NOT NULL\n           )`,",
        expect: "one reader of the same ready task is given the claim, the second is refused",
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
      {
        // A run's plan is what every later decision is read against, so a second registration
        // must not be able to replace it.
        name: "a-second-plan-overwrites-the-frozen-one",
        ast: { within: "insertTaskRunManifest" },
        from: "      if (\n        String(existing.plan_digest) !== input.planDigest ||\n        String(existing.policy) !== input.policy\n      )",
        to: "      if (\n        false &&\n        String(existing.plan_digest) !== input.planDigest &&\n        String(existing.policy) !== input.policy\n      )",
        expect: "a run registers once, and a second plan for the same run is refused",
      },
      {
        // Frozen means frozen: the same task id with a different definition is a different plan,
        // and replacing it in place would rewrite the input a decision was already read against.
        name: "a-frozen-task-is-replaced-by-a-different-definition",
        ast: { within: "insertTaskRunTask" },
        from: "      if (!same)",
        to: "      if (!same && false)",
        expect: "freezing a task twice is a no-op, and a different definition for it is refused",
      },
      {
        // The fact's own identity is what makes a retry after a lost response append once.
        name: "a-retried-run-fact-is-appended-twice",
        ast: { within: "insertTaskRunFact" },
        from: "    if (known) return { sequence: Number(known.sequence), recorded: false };",
        to: "    if (known && false) return { sequence: Number(known.sequence), recorded: false };",
        expect: "appending the same fact twice records it once and keeps the first sequence",
      },
      {
        // The fact write has to join the transition the caller opened, not open a second one; the
        // board write and the run fact of one transition stand or fall together.
        name: "the-run-fact-opens-its-own-transaction",
        ast: { within: "appendTaskRunFact" },
        from: "    return port\n      ? this.withPort(port, () => this.insertTaskRunFact(input))\n      : this.writeTransaction(() => this.insertTaskRunFact(input));",
        to: "    void port;\n    return this.writeTransaction(() => this.insertTaskRunFact(input));",
        expect: "a board write and a run fact land together, and neither lands alone",
      },
      {
        // One managed entry belongs to one run: answering with the first binding would hand a
        // second run's facts to whoever asked.
        name: "a-second-run-adopts-a-bound-entry",
        ast: { within: "taskRunForEntry" },
        from: "    if (runs.size > 1)",
        to: "    if (runs.size > 1 && false)",
        expect: "an entry bound by two runs is refused rather than answered with one of them",
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
      "tests/integration/ooo-acceptance-one-predicate.test.ts",
      "tests/integration/ooo-round-query.test.ts",
      "tests/integration/ooo-ordinary-failure.test.ts",
      "tests/integration/ooo-read-paths-agree.test.ts",
      "tests/integration/ooo-managed-fence.test.ts",
    ],
    mutants: [
      {
        // The borrowed view must not reopen the writer's path: this mutant makes the read path
        // migrate and publish the store it was asked only to read.
        name: "the-status-read-path-opens-the-rounds-store",
        ast: { within: "openRoundQuery" },
        from: "const db = new DatabaseSync(databasePath, { readOnly: true });",
        to: "const db = new BoardAdmission(databasePath) as unknown as DatabaseSync;",
        expect: "the query port reads a round without migrating, publishing or exposing a write",
      },
      {
        // Located inside the reader: a rename of the call proves the check counts call sites.
        name: "the-board-read-path-stops-calling-the-predicate",
        ast: { within: "readAccepted" },
        from: "acceptedFact({",
        to: "locallyAccepted({",
        expect: "acceptance has one home, and both readers reach it",
      },
      {
        // A bypass that still type-checks: the suite must notice the second decision.
        name: "the-board-decides-acceptance-on-its-own",
        ast: { within: "readAccepted" },
        from: "!acceptedFact({",
        to: '!(recorded?.verdict === "accepted" ? false : true) && !acceptedFact({',
        expect: "acceptance has one home, and both readers reach it",
      },
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
        ast: { within: "readAccepted" },
        from: "        verdict: recorded?.verdict ?? null,",
        to: '          verdict: "accepted",',
        expect:
          "an outside rejection withdraws the release of a dependent, and the round fails closed",
      },
      {
        name: "verdict-lookup-not-bound-to-the-artifact",
        ast: { within: "readAccepted" },
        from: "    const recorded = verdictOf.get(roundChannel(runId), digest) as unknown as",
        to: '    const recorded = verdictOf.get(roundChannel(runId), "%") as unknown as',
        expect: "the board verdict is what accepts an artifact, not the round's own column",
      },
      {
        name: "cancellation-does-not-stop-a-claim",
        ast: { within: "claim" },
        from: '    if (!id || !agentId) throw new Error("task and agent required");\n    if (this.cancelled() !== null) throw new Error("round cancelled");',
        to: '    if (!id || !agentId) throw new Error("task and agent required");',
        expect: "a cancellation names the lease it revokes, and the batch behind it is refused",
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
      {
        // The borrowed view is one implementation serving two paths. Letting the offline port
        // answer from its own rule is exactly the divergence this target exists to catch.
        name: "the-offline-reader-decides-acceptance-on-its-own",
        ast: { within: "openRoundQuery" },
        from: "      accepted: () => readAccepted(db, resolved),",
        to: "      accepted: () => ({}),",
        expect: "the owner's view and the offline reader report the same facts",
      },
      {
        // Reopening withdraws what was built from the value that no longer exists. Clearing every
        // accepted task instead takes back work the host already accepted.
        name: "reopening-one-task-clears-every-acceptance",
        ast: { within: "reopen" },
        from: "      const affected = new Set([id]);",
        to: "      const affected = new Set(rows.map((row) => row.id));",
        expect: "a later refusal does not withdraw the prefix that was already accepted",
      },
      {
        // The first decision is the one that took effect. A second cancellation that rewrites it
        // is a state patch overwriting a terminal fact.
        name: "a-second-cancellation-overwrites-the-first-decision",
        ast: { within: "cancel" },
        from: "    const already = this.cancelled();\n    if (already !== null) return [];",
        to: "    const already = this.cancelled();\n    if (false && already !== null) return [];",
        expect: "a cancellation names the lease it revokes, and the batch behind it is refused",
      },
      {
        // The frozen plan is the run's input, and installing a second one over it is the second
        // editable task truth the design forbids. The constructor refuses by policy digest.
        name: "a-second-plan-silently-adopts-the-run",
        from: "    if (recorded && recorded.policy !== wanted)",
        to: "    if (false && recorded && recorded.policy !== wanted)",
        expect: "the frozen plan has one owner, and a second, different plan is refused",
      },
      {
        // Verification is await-capable, so a ticket can be retired while it runs. Dropping the
        // re-check at the commit is how a decision made before the wait is applied after it.
        name: "the-commit-trusts-a-claim-the-board-retired",
        ast: { within: "commitArtifact" },
        from: '      if (!this.live(row)) return "stale";',
        to: '      if (false && !this.live(row)) return "stale";',
        expect: "a claim the board retires inside the verification window cannot be committed",
      },
      {
        // The decision is a fact in the store. Keeping it only in the process that made it is
        // what would let a restart resume a stopped round.
        name: "cancelling-a-round-forgets-its-reason",
        ast: { within: "cancel" },
        from: '        .prepare("UPDATE ooo_probe_runs SET cancel_reason=?, cancelled_at=? WHERE run_id=?")\n        .run(reason.slice(0, 1_000), new Date(this.now).toISOString(), this.runId);',
        to: '        .prepare("UPDATE ooo_probe_runs SET cancel_reason=NULL, cancelled_at=? WHERE run_id=?")\n        .run(reason.slice(0, 1_000), new Date(this.now).toISOString(), this.runId);',
        expect: "the terminal decision outlives the host that made it, and still refuses new work",
      },
    ],
  },
  {
    target: "src/integration/ooo-execution.ts",
    suites: [
      "tests/integration/ooo-ordinary-failure.test.ts",
      "evals/ooo-execution/patch-cycle.test.ts",
    ],
    mutants: [
      {
        name: "selection-ignores-a-withdrawn-acceptance",
        ast: { within: "nextTask" },
        from: "  const selectable = plan.filter((task) => task.accepted || !task.delivered);",
        to: "  const selectable = plan;",
        expect:
          "an outside rejection withdraws the release of a dependent, and the round fails closed",
      },
      {
        name: "a-live-claim-does-not-block-selection",
        ast: { within: "nextTask" },
        from: "  if (pending.some((task) => task.claimed) || pending.filter(waiting).length > 1) return null;",
        to: "  if (pending.filter(waiting).length > 1) return null;",
        expect: "with no fusion point the plan falls back to its declared order",
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
    .join("\\s+");
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

/** The failure lines a suite run reported. Used for both verdicts: a surviving mutant
 *  and a clean run that failed. The clean run is the one that proves nothing, so
 *  naming its failing case is what turns "the harness proves nothing" into a fix. */
function observedFailures(out: string): string[] {
  return out
    .split("\n")
    .filter((line) => line.startsWith("✖ ") || line.includes("Error"))
    .slice(0, 3);
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
  if (!clean.ok)
    problems.push(
      `${target}: clean run failed, the harness proves nothing (observed: ${
        observedFailures(clean.out).join(" | ") || "no failure line reported"
      })`,
    );
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
      const observed = observedFailures(result.out);
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
