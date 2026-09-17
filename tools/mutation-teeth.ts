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
      "tests/integration/ooo-managed-write.test.ts",
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
      {
        // A managed entry's write belongs to its run's scope: the store is the only thing that can
        // tell a coordinated write from a verb reached around it.
        name: "a-managed-entry-ignores-the-coordinated-scope",
        ast: { within: "requireManagedWriteScope" },
        from: "    if (this.coordinatedRun === binding.runId) return;",
        to: "    if (true) return;",
        expect: "a direct board verb cannot move an entry a run has adopted",
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
      "tests/integration/ooo-publication-invariants.test.ts",
      "evals/ooo-execution/patch-cycle.test.ts",
    ],
    mutants: [
      {
        // A cancellation is a fact about the task, so it gates dispatch the way a rejection gates
        // a dependent. This is the half acceptance already had and eligibility did not.
        name: "a-cancelled-task-is-still-dispatched",
        ast: { within: "nextTask" },
        from: "    current(task) &&\n    !task.cancelled &&",
        to: "    current(task) &&",
        expect: "a cancelled task is not dispatched, and nothing reads one as a closed input",
      },
      {
        name: "the-dispatch-does-not-require-a-cancelled-input-to-be-closed",
        ast: { within: "nextTask" },
        from: "    if (!task || !task.accepted || task.cancelled || !current(task) || visiting.has(id))",
        to: "    if (!task || !task.accepted || !current(task) || visiting.has(id))",
        expect: "nextTask refuses a task marked cancelled, whatever else the caller set",
      },
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
    target: "src/integration/task-semantics-interleavings.ts",
    suites: ["tests/integration/ooo-publication-invariants.test.ts"],
    mutants: [
      {
        // Every condition in the checker is deleted once, and the case that names it has to fail:
        // a condition no case can reach is a comment, not a check.
        name: "the-completion-does-not-bind-the-verdict-to-the-bytes",
        from: "    else if (verdict.digest !== artifact)",
        to: "    else if (false && verdict.digest !== artifact)",
        expect: "the checker reports a completion whose verdict judged other bytes",
      },
      {
        // Whether an input is current, and whether its bytes are the bytes its verdict judged, is the
        // one acceptance predicate's answer; the checker asks it instead of comparing by hand.
        name: "the-input-is-not-required-to-be-accepted",
        ast: { within: "checkInputs" },
        from: "    if (dependencyUnit && !isAccepted(dependencyUnit, context.facts))",
        to: "    if (false && dependencyUnit && !isAccepted(dependencyUnit, context.facts))",
        expect: "the checker reports a completion resting on an input that drifted",
      },
      {
        name: "the-input-may-be-cancelled",
        ast: { within: "checkInputs" },
        from: "    if (cancelled(context.facts, dependency))",
        to: "    if (false && cancelled(context.facts, dependency))",
        expect: "the checker reports a completion resting on a cancelled input",
      },
      {
        name: "the-completion-ignores-a-cancelled-unit",
        ast: { within: "checkCompletion" },
        from: "  if (cancelled(context.facts, unit.id))",
        to: "  if (false)",
        expect: "the checker reports a completion of a cancelled unit",
      },
      {
        name: "the-dispatch-does-not-require-a-closed-input",
        ast: { within: "checkDispatch" },
        from: '  checkInputs(context, unit, "dispatch");',
        to: "  void checkInputs;",
        expect: "the checker reports a dispatch whose input is not accepted",
      },
      {
        // The enumeration is the other half of the claim: a merge that stops at the first order
        // checks one interleaving and reports it as all of them.
        name: "the-merge-enumerates-one-order",
        ast: { within: "interleavings" },
        from: "  return out;",
        to: "  return out.slice(0, 1);",
        expect: "the merge enumerates every legal order, not one of them",
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
        // The closure takes the unit-level predicate, so the marker names the two conditions it
        // joins: a unit's own acceptance and every dependency being in the set.
        name: "acceptance-closure-dropped",
        from: "        own(unit) && unit.inputs.dependencies.every((dependency) => accepted.has(dependency));",
        to: "        own(unit);",
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
        expect:
          "the board drivers run the protocol end to end through the daemon that serves the store",
      },
      {
        // The whole boundary is that a driver reaches the board through the daemon. A convenience
        // import of the store is how that boundary rots, and the structural check is what catches it
        // rather than a later round discovering a second writer.
        name: "a-driver-falls-back-to-opening-the-store",
        from: "const state = roundDaemon(resolve(values.daemon));",
        to: 'const state = roundDaemon(resolve(values.daemon));\nconst store = (await import("../../src/core/store/base.ts")).NmgStoreBase;',
        expect: "a driver refuses without a daemon, and no driver opens a database of its own",
      },
    ],
  },
  {
    // The adapter is the only thing between a driver and the file it must not open: without its
    // refusal, a missing daemon reads as a store the driver is free to open itself.
    target: "evals/ooo-execution/round-client.ts",
    suites: ["tests/integration/ooo-evidence-drivers.test.ts"],
    mutants: [
      {
        name: "the-round-client-does-not-require-a-daemon",
        from: '  if (!state || state.transport !== "http" || !state.host || !state.port || !state.token) {',
        to: '  if (false && (!state || state.transport !== "http" || !state.host || !state.port || !state.token)) {',
        expect: "a driver refuses without a daemon, and no driver opens a database of its own",
      },
      {
        // Whether a call to an endpoint the caller itself serves can be answered depends on the
        // caller not blocking - the assumption that turned this failure into a 305-second wait.
        name: "the-round-client-calls-the-endpoint-it-serves",
        from: "  if (state.pid === process.pid) {",
        to: "  if (false && state.pid === process.pid) {",
        expect: "a client refuses to call the endpoint its own process serves",
      },
      {
        // Without a bound, a blocked host is indistinguishable from a slow one, and the caller waits
        // out the transport's own timeout instead of being told what to look at.
        name: "the-round-client-has-no-limit-on-how-long-it-waits",
        from: "    return await httpCall(state, method, params, { timeoutMs });",
        to: "    return await httpCall(state, method, params, {});",
        expect: "a call to a host that never answers gives up in seconds and names the reason",
      },
    ],
  },
  {
    // A lease is the store's answer to "who serves this?" - a lease held by a process that is gone is
    // a store nothing can serve, which is the same class of failure as a blocked host: the writer is
    // absent and every client's answer depends on it coming back.
    target: "src/cli/http-server.ts",
    suites: ["tests/integration/ooo-evidence-drivers.test.ts"],
    mutants: [
      {
        name: "the-serving-process-never-releases-its-lease",
        from: "  lease.release();",
        to: "  // lease.release();",
        expect: "a host releases its lease when it stops, so the next host can take the store",
      },
    ],
  },
  {
    target: "src/integration/task-coordinator.ts",
    suites: [
      "tests/integration/ooo-managed-write.test.ts",
      "tests/integration/ooo-managed-adopt.test.ts",
      "tests/cli/task-run-surface.test.ts",
    ],
    mutants: [
      {
        // Binding is what makes an entry managed, so the refusal has to read the stored fact rather
        // than whatever the caller believes about the entry.
        name: "an-adopted-entry-takes-the-direct-path",
        from: "  if (!binding) return request.apply();",
        to: "  if (binding) return request.apply();",
        expect:
          "the routing rule sends a managed entry to its run and leaves an unmanaged one alone",
      },
      {
        // A run cannot adopt an entry for work it never froze: otherwise the binding names a task
        // no decision was ever read against.
        name: "a-binding-ignores-whether-the-task-was-frozen",
        from: "    if (!isFrozen(store, request.runId, request.taskId))",
        to: "    if (false && !isFrozen(store, request.runId, request.taskId))",
        expect: "a binding refuses what the store does not hold",
      },
      {
        // The binding names an entry the board really holds, on the channel the caller names.
        name: "a-binding-does-not-check-the-entry-exists",
        from: "    if (!store.getTaskBoardEntryById(request.boardTaskId, request.entryId))",
        to: "    if (false && !store.getTaskBoardEntryById(request.boardTaskId, request.entryId))",
        expect: "a binding refuses what the store does not hold",
      },
      {
        // One entry carries one task: without this a second run would fence an entry it does not
        // own, and the fence would refuse the first run's own writes.
        name: "one-entry-is-bound-to-two-tasks",
        from: "    if (bound && (bound.runId !== request.runId || bound.taskId !== request.taskId))",
        to: "    if (false && bound && (bound.runId !== request.runId || bound.taskId !== request.taskId))",
        expect: "a binding refuses what the store does not hold",
      },
      {
        // A second entry for the same task and attempt is a disagreement. The stored fact is keyed
        // by task and attempt, so accepting it would keep the first binding and report the second.
        name: "a-second-entry-rebinds-the-task",
        from: "    if (existing && existing.entryId !== request.entryId)",
        to: "    if (false && existing && existing.entryId !== request.entryId)",
        expect: "a binding is idempotent for its task and attempt, and refuses a second entry",
      },
      {
        // The transition is the run's record of what happened to its entry; without it the board
        // moved and the run has nothing to read.
        name: "a-coordinated-write-skips-its-run-fact",
        from: "    const fact = store.appendTaskRunFact(\n      {\n        runId: request.runId,\n        kind: managedTransitionKind(request.verb),\n        taskId: binding.taskId,\n        attempt: binding.attempt,\n        entryId: request.entryId,\n        payload: JSON.stringify({ actorId: request.actorId, status }),\n      },\n      port,\n    );",
        to: "    const fact = { sequence: 0, recorded: true };",
        expect: "a coordinated write lands the board transition and the run's fact together",
      },
      {
        // A cancelled run is the end of its managed entries' lifecycle, and the fence is the only
        // thing that says so.
        name: "a-cancelled-run-still-accepts-writes",
        from: "  if (cancelled)\n    return `run ${runId} was cancelled at sequence ${cancelled.sequence}; its managed entries take no further lifecycle writes`;",
        to: "  if (cancelled && false)\n    return `run ${runId} was cancelled at sequence ${cancelled.sequence}; its managed entries take no further lifecycle writes`;",
        expect: "a cancelled run takes no further lifecycle writes on what it adopted",
      },
      {
        // The binding is re-read where the write happens, not where the caller decided to make it.
        name: "a-coordinated-write-skips-the-binding-recheck",
        from: "    if (binding.runId !== request.runId)",
        to: "    if (false && binding.runId !== request.runId)",
        expect: "a coordinated write refuses an entry that is not this run's",
      },
      {
        // The run surface's transitions: a plan the run cannot satisfy is refused while it is still
        // a proposal rather than frozen into a task that can never be ready.
        name: "the-plan-may-freeze-a-dangling-dependency",
        from: "      if (!known.has(dependency))",
        to: "      if (false && !known.has(dependency))",
        expect: "a freeze cannot dangle, repeat a task, or lean on itself",
      },
      {
        // A task that waits for itself is a task that is never ready, and the freeze is the last
        // point at which that is still only a proposal.
        name: "a-task-may-depend-on-itself",
        from: "      if (dependency === task.taskId)",
        to: "      if (false && dependency === task.taskId)",
        expect: "a freeze cannot dangle, repeat a task, or lean on itself",
      },
      {
        // Freezing is one transition: a batch where the store refuses one task must not leave the
        // earlier ones frozen, or a plan exists that no caller ever proposed.
        name: "the-plan-freezes-one-task-per-transaction",
        from: "  return store.coordinateRunWrite(request.runId, (port) => {\n    // The array order is the plan order: the position comes from here, not from the request.\n    request.tasks.forEach((task, position) =>\n      store.freezeTaskRunTask({ ...task, runId: request.runId, position }, port),\n    );\n    return { runId: request.runId, frozen: request.tasks.length };\n  });",
        to: "  request.tasks.forEach((task, position) =>\n    store.freezeTaskRunTask({ ...task, runId: request.runId, position }),\n  );\n  return { runId: request.runId, frozen: request.tasks.length };",
        expect: "a refused freeze leaves the plan exactly as it was",
      },
      {
        // The plan order is the array order: the position comes from that loop, so freezing every
        // task at zero would leave the stored plan's order to the task ids.
        name: "every-task-is-frozen-at-position-zero",
        from: "    request.tasks.forEach((task, position) =>\n      store.freezeTaskRunTask({ ...task, runId: request.runId, position }, port),\n    );",
        to: "    request.tasks.forEach((task) =>\n      store.freezeTaskRunTask({ ...task, runId: request.runId, position: 0 }, port),\n    );",
        expect: "a run registers, freezes a plan, adopts entries, and reads it all back",
      },
      {
        // A cancelled run is closed: its plan is not extended behind the cancellation that every
        // other rule in this file already honours.
        name: "a-cancelled-run-takes-a-new-plan",
        from: "  const refusal = managedWriteRefusal(store, request.runId);\n  if (refusal) throw new Error(refusal);",
        to: "  const refusal: string | null = null;\n  if (refusal) throw new Error(refusal);",
        ast: { within: "freezeRunPlan" },
        expect: "a cancelled run takes no further plan",
      },
      {
        // The binding records which channel carries the entry, which is what lets a status reader
        // resolve it without searching every channel.
        name: "a-binding-does-not-record-its-channel",
        from: "        payload: JSON.stringify({ boardTaskId: request.boardTaskId }),",
        to: "        payload: null,",
        expect: "a run registers, freezes a plan, adopts entries, and reads it all back",
      },
      {
        // Creating the entry and adopting it are one transition. Two calls would leave an unmanaged
        // entry behind when the binding is refused - the hole the run fence exists to close.
        name: "the-entry-is-created-before-its-binding-is-checked",
        from: "  return store.writeTransaction((port) => {\n    const entry = store.putTaskBoardEntry(request.entry, port);",
        to: "  return store.writeTransaction(() => {\n    const entry = store.putTaskBoardEntry(request.entry);",
        expect:
          "adoption is part of the transition that creates the entry, so a refusal leaves no entry",
      },
      {
        // A run-level cancellation is the run's fact, not a task's: the schema's empty task id is
        // what keeps it from colliding with a task that has no name.
        name: "a-run-cancellation-names-a-task",
        from: '        taskId: request.taskId ?? "",',
        to: '        taskId: request.taskId ?? "-",',
        expect: "cancelling a run is recorded once, stops its managed writes, and is readable",
      },
      {
        // Cancelling a task the plan never froze would name nothing while reading as a fact about
        // the run.
        name: "a-cancellation-ignores-whether-the-task-was-frozen",
        from: "  if (request.taskId !== undefined && !isFrozen(store, request.runId, request.taskId))",
        to: "  if (false && request.taskId !== undefined && !isFrozen(store, request.runId, request.taskId))",
        expect: "cancelling one task names it, and a task the plan never froze cannot be cancelled",
      },
      {
        // There is nothing to cancel in a run this store cannot name, and the refusal says so
        // rather than leaving it to the transaction's own message.
        name: "an-unknown-run-can-be-cancelled",
        from: "  if (!store.taskRunManifest(request.runId))",
        to: "  if (false && !store.taskRunManifest(request.runId))",
        expect:
          "status is a read: an unknown run has no manifest and is not registered by being asked",
      },
      {
        // A status read registers and appends nothing: a view that repaired what it could not find
        // would make its own answer true.
        name: "status-registers-the-run-it-cannot-find",
        from: "    manifest: store.taskRunManifest(runId),",
        to: '    manifest: (store.registerTaskRun({ runId, planDigest: "", policy: "", revision: "", retention: "" }), store.taskRunManifest(runId)),',
        expect:
          "status is a read: an unknown run has no manifest and is not registered by being asked",
      },
    ],
  },
  {
    target: "src/cli/service.ts",
    suites: ["tests/integration/ooo-managed-write.test.ts", "tests/cli/task-run-surface.test.ts"],
    mutants: [
      {
        // The routing is what keeps the daemon's verbs out of the store's refusal: a managed entry
        // reached directly from a handler cannot be moved at all. The rule itself lives in the
        // coordinator (one home for it), so this mutant pins that the daemon's claim still goes
        // through it rather than at the store.
        name: "the-daemon-verb-skips-the-coordinated-path",
        from: '      entry: coordinatedEntryWrite(store, {\n        verb: "claim",\n        entryId: p.entryId,\n        actorId: p.agentId,\n        apply: () => store.claimTaskBoardEntry(p),\n      }),',
        to: "      entry: store.claimTaskBoardEntry(p),",
        expect: "a daemon board verb routes a managed entry through the run's transition",
      },
      {
        // The wire drops an adoption request: the entry is created, the caller is told the put
        // succeeded, and no run manages it - the silent divergence the epoch rule exists for.
        name: "the-wire-drops-an-adoption-request",
        from: "      adopt: optionalAdoption(params.adopt),",
        to: "      adopt: undefined,",
        expect:
          "adoption is part of the transition that creates the entry, so a refusal leaves no entry",
      },
    ],
  },
  {
    // The shared-floor decision: a route may declare the always-run shared checks not applicable to
    // its own surface, and that declaration must be honoured for exactly that route and nothing else.
    target: "tools/narrow-verify.ts",
    suites: ["tests/tools/narrow-verify.test.ts"],
    mutants: [
      {
        name: "the-declined-shared-checks-still-run",
        from: '  const declined = route.verify.sharedChecks === "none";',
        to: "  const declined = false;",
        expect: "a route that declares the shared checks not applicable narrows to its own tests",
      },
      {
        // An absent declaration means "always". Reading anything that is not the explicit
        // "always" as a decline would silently drop the floor for every route that never asked.
        name: "an-undeclared-route-is-read-as-declining",
        from: 'route.verify.sharedChecks === "none"',
        to: 'route.verify.sharedChecks !== "always"',
        expect: "a change cleanly owned by one leaf route narrows to its own tests",
      },
    ],
  },
  {
    // The declaration is refused at config load when it would leave a plan with nothing to execute,
    // and an unknown value must not silently mean either answer.
    target: "tools/repo-context.ts",
    suites: ["tests/tools/repo-context.test.ts"],
    mutants: [
      {
        name: "a-declined-floor-may-have-no-tests",
        from: 'if (sharedChecks === "none" && !route.tests.length) {',
        to: 'if (false && sharedChecks === "none" && !route.tests.length) {',
        expect:
          "verify.sharedChecks must be a known declaration, and declining needs its own tests",
      },
      {
        name: "an-unknown-shared-checks-value-is-accepted",
        from: 'if (sharedChecks !== undefined && sharedChecks !== "always" && sharedChecks !== "none") {',
        to: 'if (false && sharedChecks !== undefined && sharedChecks !== "always" && sharedChecks !== "none") {',
        expect:
          "verify.sharedChecks must be a known declaration, and declining needs its own tests",
      },
    ],
  },
  {
    // One home for the check list: the plan decides it, including a route's decline. A caller that
    // rebuilt the floor from the constant would execute checks the plan said not to.
    target: "tools/agent-verify.ts",
    suites: ["tests/tools/agent-verify.test.ts"],
    mutants: [
      {
        name: "the-caller-rebuilds-the-shared-floor",
        from: "? [...narrowPlan.shared, ...(route.tests.length ? [nodeTestCheckName(route.id)] : [])]",
        to: '? ["check", "docs:check", "format:check", "glossary:check", "lint", "package:check", "rtm:check", ...(route.tests.length ? [nodeTestCheckName(route.id)] : [])]',
        expect: "a route that declines the shared checks plans only its own tests",
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
