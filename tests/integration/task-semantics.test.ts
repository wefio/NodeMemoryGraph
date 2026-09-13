/**
 * Task-unit semantics: the compiler is a read-only view over the contracts that
 * already exist, so these tests assert two kinds of thing — that it refuses
 * unsupported mappings with a location instead of dropping them, and that a fact
 * has exactly one predicate (acceptance), shared by the status query and
 * dependency release.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MODELLED_ACTIONS,
  UNMODELLED_ACTIONS,
  acceptedFact,
  checkRefinement,
  compileTaskUnits,
  deriveStatus,
  dispatchTasks,
  isAccepted,
  type CompileInput,
} from "../../src/integration/task-semantics.ts";
import type { PatchTaskSpec, ProbePlan } from "../../src/integration/ooo-board.ts";
import { MAX_PATCH_BUDGET } from "../../src/integration/ooo-patch.ts";

const verify = async () => "accept" as const;

const spec = (overrides: Partial<PatchTaskSpec> = {}): PatchTaskSpec => ({
  instruction: "Rename byId to planIndex in nextTask only.",
  files: { "src/integration/ooo-execution.ts": "export const planIndex = 1;\n" },
  editable: ["src/integration/ooo-execution.ts"],
  verify,
  ...overrides,
});

const plan: ProbePlan = [
  ["P", "4", [], "isolated-artifact", null, null],
  ["D", "5", ["P"], "read-only", null, "double"],
];

const input = (overrides: Partial<CompileInput> = {}): CompileInput => ({
  plan,
  specs: { P: spec() },
  ...overrides,
});

test("compiles a plan into a read-only view and binds it with a digest", () => {
  const before = JSON.stringify(plan);
  const first = compileTaskUnits(input());
  const second = compileTaskUnits(input());

  assert.equal(JSON.stringify(plan), before, "compiling must not mutate the plan");
  assert.deepEqual(first.refusals, []);
  assert.equal(first.legal, true);
  assert.equal(first.digest, second.digest, "the same input yields the same view");
  assert.deepEqual(
    first.units.map((unit) => unit.id),
    ["P", "D"],
  );
  const patchUnit = first.units[0]!;
  assert.ok(patchUnit.patch, "a unit with a host spec carries the frozen envelope");
  assert.equal(patchUnit.patch.files[0], "src/integration/ooo-execution.ts");
  assert.equal(patchUnit.patch.visible.length, 1, "visible defaults to the readable set");
  assert.deepEqual(patchUnit.patch.editable, ["src/integration/ooo-execution.ts"]);
  assert.equal(patchUnit.requires.length, 0);
  assert.equal(first.units[1]!.patch, null, "a unit without a spec stays an internal unit");
});

test("refuses an unknown dependency, a self dependency and a cycle, each located", () => {
  const unknown = compileTaskUnits(
    input({
      plan: [["A", "1", ["ghost"], "read-only", null, null]] as unknown as ProbePlan,
      specs: {},
    }),
  );
  assert.equal(unknown.legal, false);
  assert.equal(unknown.refusals[0]!.task, "A");
  assert.equal(unknown.refusals[0]!.field, "dependencies");
  assert.equal(unknown.refusals[0]!.obligation, "input-closure");

  const self = compileTaskUnits(
    input({
      plan: [["A", "1", ["A"], "read-only", null, null]] as unknown as ProbePlan,
      specs: {},
    }),
  );
  assert.ok(self.refusals.some((refusal) => /cannot depend on itself/u.test(refusal.reason)));

  const cycle = compileTaskUnits(
    input({
      plan: [
        ["A", "1", ["B"], "read-only", null, null],
        ["B", "1", ["A"], "read-only", null, null],
      ] as unknown as ProbePlan,
      specs: {},
    }),
  );
  assert.ok(
    cycle.refusals.some(
      (refusal) => refusal.field === "dependencies" && /cycle/u.test(refusal.reason),
    ),
  );
});

test("refuses the aliases that would turn a byte budget into a token claim", () => {
  const result = compileTaskUnits(
    input({
      specs: {
        P: spec({
          maxBytes: 16_000,
          maxOutputTokens: 4_000,
          limits: { turns: 2, reads: 1, timeoutMs: 1_000, deadlineMs: 60_000 },
        } as unknown as Partial<PatchTaskSpec>),
      },
    }),
  );
  const fields = result.refusals.map((refusal) => refusal.field).sort();
  assert.deepEqual(fields, ["limits.deadlineMs", "maxBytes", "maxOutputTokens"]);
  assert.equal(result.legal, false);
  assert.equal(result.units.find((unit) => unit.id === "P")!.patch, null);
});

test("refuses a spec for an unknown task and a unit with no host verifier", () => {
  const extra = compileTaskUnits(input({ specs: { P: spec(), ghost: spec() } }));
  const refusal = extra.refusals.find((candidate) => candidate.task === "ghost");
  assert.equal(refusal?.field, "spec");
  assert.equal(refusal?.obligation, "input-closure");

  const noVerifier = compileTaskUnits(
    input({ specs: { P: spec({ verify: undefined } as unknown as Partial<PatchTaskSpec>) } }),
  );
  const located = noVerifier.refusals.find((candidate) => candidate.field === "verify");
  assert.equal(located?.task, "P");
  assert.equal(located?.obligation, "explicit-acceptance");
});

test("refuses a read or write path outside the frozen files", () => {
  const result = compileTaskUnits(
    input({ specs: { P: spec({ visible: ["src/other.ts"], editable: ["src/not-frozen.ts"] }) } }),
  );
  const fields = result.refusals.map((refusal) => refusal.field).sort();
  assert.deepEqual(fields, ["editable", "visible"]);
  assert.ok(result.refusals.every((refusal) => refusal.obligation === "permission-closure"));
});

test("refuses an unknown requirement kind and a requirement naming an unknown task", () => {
  const confused = compileTaskUnits(
    input({
      requires: { D: [{ kind: "depends-on", task: "P" }] } as unknown as CompileInput["requires"],
    }),
  );
  assert.ok(
    confused.refusals.some(
      (refusal) =>
        refusal.field === "requires" && /is a dependency, not a requirement/u.test(refusal.reason),
    ),
  );

  const unknown = compileTaskUnits(
    input({ requires: { D: [{ kind: "verified", task: "ghost" }] } }),
  );
  assert.ok(unknown.refusals.some((refusal) => refusal.field === "requires"));
});

test("acceptance needs a verdict bound to the current artifact", () => {
  const artifact = "a".repeat(64);
  const unit = { id: "P", revision: "4" };
  assert.equal(isAccepted(unit, { artifacts: { P: artifact } }), false);
  assert.equal(
    isAccepted(unit, {
      artifacts: { P: artifact },
      verdicts: { P: { digest: "b".repeat(64), verdict: "accepted" } },
    }),
    false,
    "a verdict for another artifact is not inherited",
  );
  assert.equal(
    isAccepted(unit, {
      artifacts: { P: artifact },
      verdicts: { P: { digest: artifact, verdict: "accepted" } },
    }),
    true,
  );
  assert.equal(
    isAccepted(unit, {
      artifacts: { P: artifact },
      verdicts: { P: { digest: artifact, verdict: "undecidable" } },
    }),
    false,
    "undecidable stays unaccepted",
  );
  assert.equal(
    isAccepted(unit, {
      artifacts: { P: artifact },
      verdicts: { P: { digest: artifact, verdict: "accepted" } },
      cancellations: ["P"],
    }),
    false,
  );
});

test("the status query and dependency release share one predicate", () => {
  const artifact = "c".repeat(64);
  const units = compileTaskUnits(input()).units;

  const artifactOnly = deriveStatus(units, { artifacts: { P: artifact } });
  assert.deepEqual(artifactOnly.accepted, [], "an artifact with no verdict is not acceptance");
  assert.ok(
    artifactOnly.blocked.some((entry) => entry.id === "D" && entry.waitingFor.includes("P")),
    "D waits on P until the verdict, not until the bytes exist",
  );
  assert.equal(dispatchTasks(units, { artifacts: { P: artifact } })[0]!.accepted, false);

  const judged = deriveStatus(units, {
    artifacts: { P: artifact },
    verdicts: { P: { digest: artifact, verdict: "accepted" } },
  });
  assert.deepEqual(judged.accepted, ["P"]);
  assert.deepEqual(judged.ready, ["D"], "P is accepted, so D is next");
  assert.equal(
    dispatchTasks(units, {
      artifacts: { P: artifact },
      verdicts: { P: { digest: artifact, verdict: "accepted" } },
    })[0]!.accepted,
    true,
  );

  const stale = deriveStatus(units, {
    artifacts: { P: artifact },
    verdicts: { P: { digest: artifact, verdict: "accepted" } },
    revisions: { P: "9" },
  });
  assert.deepEqual(stale.accepted, [], "a superseded revision is not current");
});

test("an unsatisfied external wait keeps a unit out of ready", () => {
  const waiting = compileTaskUnits(
    input({
      plan: [["W", "1", [], "read-only", "check-event", null]] as unknown as ProbePlan,
      specs: {},
    }),
  );
  const notReady = deriveStatus(waiting.units, {});
  assert.deepEqual(notReady.ready, []);
  const ready = deriveStatus(waiting.units, { externalReady: ["W"] });
  assert.deepEqual(ready.ready, ["W"]);
});

test("a refinement must carry every parent obligation and may not widen the write set", () => {
  const parent = compileTaskUnits(input()).units.find((unit) => unit.id === "P")!;
  const parts = compileTaskUnits(
    input({
      plan: [
        ["P", "4", [], "isolated-artifact", null, null],
        ["P1", "4", [], "isolated-artifact", null, null],
        ["P2", "4", [], "isolated-artifact", null, null],
      ] as unknown as ProbePlan,
      specs: {
        P: spec(),
        P1: spec(),
        P2: spec({
          files: { "src/elsewhere.ts": "export const elsewhere = 1;" },
          editable: ["src/elsewhere.ts"],
        }),
      },
    }),
  );
  const partial = parent.obligations.slice(0, 2);
  const refusals = checkRefinement(parts, {
    parent: "P",
    parts: ["P1", "P2"],
    join: "P1",
    obligations: Object.fromEntries(partial.map((obligation) => [obligation, ["P1"]])),
  });
  const missing = refusals.filter((refusal) => refusal.field.startsWith("obligations."));
  assert.equal(
    missing.length,
    parent.obligations.length - partial.length,
    "every unmapped obligation is named",
  );
  assert.ok(
    refusals.some((refusal) => refusal.obligation === "permission-closure"),
    "a part may not write outside the parent's write set",
  );
});

test("unmodelled actions are named rather than reported as empty", () => {
  assert.deepEqual(MODELLED_ACTIONS, ["next", "publish"]);
  assert.deepEqual(UNMODELLED_ACTIONS, ["fuse", "prepare"]);
});

test("refuses an unknown key inside budget or limits, and a range above the maximum", () => {
  const aliased = compileTaskUnits(
    input({
      specs: {
        P: spec({
          budget: { perFile: 10, output: 100, bytesPerFile: 10 },
          limits: { turns: 2, reads: 2, timeoutMs: 1_000, deadlineMs: 1_000 },
        } as unknown as Partial<PatchTaskSpec>),
      },
    }),
  );
  assert.deepEqual(
    aliased.refusals.map((refusal) => refusal.field).sort(),
    ["budget.bytesPerFile", "limits.deadlineMs"],
    "each aliased key is named once",
  );
  assert.equal(
    aliased.refusals.some((refusal) => /exceeds the frozen maximum/u.test(refusal.reason)),
    false,
    "a key with no unit is not also reported as a range violation",
  );

  const over = compileTaskUnits(
    input({
      specs: {
        P: spec({ budget: { perFile: MAX_PATCH_BUDGET.perFile + 1, output: 100 } }),
      },
    }),
  );
  assert.ok(
    over.refusals.some((refusal) => refusal.field === "budget" && /exceeds/u.test(refusal.reason)),
  );
});

test("acceptedFact is the single rule, and the view adapter does not grow its own", () => {
  const digest = "d".repeat(64);
  const base = {
    artifact: "commit",
    digest,
    verdict: "accepted",
    judgedDigest: digest,
    currentRevision: true,
  };
  assert.equal(acceptedFact(base), true);
  assert.equal(acceptedFact({ ...base, artifact: null }), false, "delivery is not acceptance");
  assert.equal(
    acceptedFact({ ...base, verdict: null }),
    false,
    "a missing verdict is not acceptance",
  );
  assert.equal(acceptedFact({ ...base, verdict: "undecidable" }), false);
  assert.equal(
    acceptedFact({ ...base, judgedDigest: "e".repeat(64) }),
    false,
    "a verdict about another digest does not transfer",
  );
  assert.equal(acceptedFact({ ...base, currentRevision: false }), false);
  assert.equal(acceptedFact({ ...base, cancelled: true }), false);

  const facts = {
    artifacts: { P: digest },
    verdicts: { P: { digest, verdict: "accepted" as const } },
  };
  assert.equal(isAccepted({ id: "P", revision: "4" }, facts), true);
  assert.equal(
    isAccepted({ id: "P", revision: "4" }, { artifacts: { P: digest } }),
    false,
    "the adapter must not accept on bytes either",
  );
});
