import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { runCycle, type CheckRunner } from "../../src/integration/ooo-cycle.ts";
import { preparePatchWork, type FrozenPatchWork } from "../../src/integration/ooo-patch.ts";

const run = promisify(execFile);

const IMPL = "src/check.ts";
const TESTS = "src/check.test.ts";
const baseline = { [IMPL]: "export const a = 1;\n", [TESTS]: "test('a', () => {});\n" };
const checks = [{ label: "fixed", command: process.execPath, args: ["-e", "process.exit(0)"] }];

/** Stub host check: rejects a candidate that keeps marker "BROKEN". */
const runChecks: CheckRunner = async ({ files }) => ({
  verdict: Object.values(files).some((text) => text.includes("BROKEN")) ? "reject" : "accept",
  outcomes: [{ label: "fixed", status: "passed" }],
});

/** Stub mutants: the declaration is only usable if the frozen suite misses it, and
 *  a candidate closes it only by making the mutated implementation fail the check. */
const mutant = (id: string, to: string) => ({
  id,
  path: IMPL,
  from: "export const a = 1;\n",
  to,
});
const mutationRunner: CheckRunner = async ({ files }) => {
  const impl = files[IMPL] ?? "";
  const tests = files[TESTS] ?? "";
  const failed =
    Object.values(files).some((text) => text.includes("BROKEN")) ||
    (impl.includes("MUTANT") && tests.includes("detects-mutant"));
  return {
    verdict: failed ? "reject" : "accept",
    outcomes: [{ label: "fixed", status: failed ? "failed" : "passed" }],
  };
};

const options = (
  worker: Parameters<typeof runCycle>[0]["worker"],
  runner: CheckRunner = runChecks,
) => ({
  repository: process.cwd(),
  revision: "0".repeat(40),
  baseline,
  checks,
  runChecks: runner,
  worker,
  aInstruction: "A works.",
  bInstruction: "B works.",
  aEditable: [IMPL],
  bEditable: [TESTS],
  budget: { perFile: 20_000, output: 40_000 },
  limits: { turns: 4, reads: 3, timeoutMs: 60_000 },
});

test("contract: B runs while A waits on the real check, then A, then C promotes", async () => {
  const order: string[] = [];
  const result = await runCycle(
    options(async (taskId, frozen, dependencies) => {
      order.push(taskId);
      if (taskId === "A") {
        // A's frozen envelope must carry the real check outcome, and its digest must
        // bind that text, not the pre-check version.
        assert.match(frozen.work.instruction, /Check [0-9a-f-]+ finished with accept/);
        return JSON.stringify({
          digest: frozen.digest,
          files: [{ path: IMPL, content: "export const a = 2;\n" }],
        });
      }
      if (taskId === "B") {
        assert.deepEqual(dependencies, {});
        assert.match(frozen.work.instruction, /Host-proven faults/);
        return JSON.stringify({
          digest: frozen.digest,
          files: [{ path: TESTS, content: "test('a', () => {}); test('b', () => {});\n" }],
        });
      }
      assert.deepEqual(Object.keys(dependencies).sort(), ["A", "B"]);
      return JSON.stringify({
        digest: frozen.digest,
        kind: "conclusion",
        conclusion: "promote-candidate",
        summary: "composed check passed",
        evidence: "candidate-check accept",
        citations: [],
      });
    }),
  );
  assert.deepEqual(order, ["B", "A", "C"]);
  assert.deepEqual(result.verdicts, { B: "accepted", A: "accepted", C: "accepted" });
  assert.equal(result.composed.verdict, "accept");
  const steps = result.timeline.map((entry) => entry.step);
  assert.ok(steps.indexOf("check-issued") < steps.indexOf("claim:B"));
  assert.ok(steps.indexOf("check-terminal") < steps.indexOf("claim:A"));
  // A's input digest is the post-check envelope, so the check evidence is bound.
  assert.match(result.timeline.find((entry) => entry.step === "claim:A")!.detail!, /digest=/);
});

test("safety: a worker that fails or truncates is a recorded failed attempt, not a crash", async () => {
  for (const message of [
    "Pi snapshot task did not finish within its bounded contract: stopReason=length, turns=2",
    "pi turn error: This operation was aborted",
  ]) {
    const result = await runCycle(
      options(async () => {
        throw new Error(message);
      }),
    );
    assert.equal(result.verdicts.B, "rejected");
    assert.equal(result.verdicts.A, undefined);
    assert.equal(result.verdicts.C, undefined);
    assert.deepEqual(result.accepted, {});
    assert.equal(result.rejections[0].artifact, message);
    assert.ok(result.timeline.some((entry) => entry.step === "worker-failed:B"));
  }
});

test("contract: an artifact the shared contract refuses records why, and still submits", async () => {
  const result = await runCycle(
    options(async (_task, frozen) =>
      // An extra top-level key is invisible in the verdict without this record.
      JSON.stringify({ digest: frozen.digest, files: [], verdict: "accept" }),
    ),
  );
  assert.equal(result.verdicts.B, "rejected");
  const recorded = result.timeline.find((entry) => entry.step === "contract-error:B");
  assert.ok(recorded, "the shared contract's own reason is recorded");
  assert.match(recorded.detail!, /invalid patch files|invalid patch structure/);
  assert.ok(result.timeline.some((entry) => entry.step === "submit:B"));
});

test("safety: rejection stops without synthetic lease expiry or automatic model retry", async () => {
  let runs = 0;
  const result = await runCycle(
    options(async (taskId, frozen) => {
      runs += 1;
      const path = taskId === "A" ? IMPL : TESTS;
      return JSON.stringify({ digest: frozen.digest, files: [{ path, content: "BROKEN\n" }] });
    }),
  );
  assert.equal(result.verdicts.B, "rejected");
  assert.equal(result.verdicts.A, undefined);
  assert.equal(result.verdicts.C, undefined);
  assert.deepEqual(result.accepted, {});
  assert.equal(runs, 1);
  assert.equal(result.rejections.length, 1);
  assert.ok(!result.timeline.some((entry) => entry.step === "retry:B"));
  assert.ok(result.timeline.some((entry) => entry.step === "skip:A"));
  assert.ok(result.timeline.some((entry) => entry.step === "skip:C"));
});

test("safety: nonempty worker conclusions do not establish coverage", async () => {
  for (const conclusion of ["no-change-needed", "cannot-complete", "promote-candidate"]) {
    const result = await runCycle(
      options(async (_task, frozen) =>
        JSON.stringify({
          digest: frozen.digest,
          kind: "conclusion",
          conclusion,
          summary: "Everything is covered",
          evidence: "the tests passed",
          citations: [],
        }),
      ),
    );
    assert.equal(result.verdicts.B, "rejected");
    assert.deepEqual(result.accepted, {});
  }
});

test("contract: a no-change conclusion is accepted only when every frozen case resolves", async () => {
  const cases = [
    { name: "stale", token: "stale" },
    { name: "duplicate", token: "duplicate" },
    { name: "cancel-late", token: "cancel" },
  ];
  const run = (citations: { case: string; test: string }[]) =>
    runCycle({
      ...options(async (_task, frozen) =>
        JSON.stringify({
          digest: frozen.digest,
          kind: "conclusion",
          conclusion: "no-change-needed",
          summary: "cases already covered",
          evidence: "each cited title exists in the frozen test source",
          citations,
        }),
      ),
      noChangeCases: { B: cases },
    });
  const fully = [
    { case: "stale", test: "a" },
    { case: "duplicate", test: "a" },
    { case: "cancel-late", test: "a" },
  ];
  assert.equal((await run(fully)).verdicts.B, "accepted");
  // A missing case, a misquoted title, and an invented case all fail closed.
  for (const citations of [
    [{ case: "stale", test: "a" }],
    [
      { case: "stale", test: "a" },
      { case: "duplicate", test: "a" },
      { case: "cancel-late", test: "not a real test title" },
    ],
    [...fully, { case: "invented", test: "a" }],
  ]) {
    const result = await run(citations);
    assert.equal(result.verdicts.B, "rejected");
    assert.ok(result.timeline.some((entry) => entry.step === "citation-unresolved"));
  }
});

test("safety: a cannot-complete report stops the round instead of unlocking dependents", async () => {
  const result = await runCycle(
    options(async (_task, frozen) =>
      JSON.stringify({
        digest: frozen.digest,
        kind: "conclusion",
        conclusion: "cannot-complete",
        summary: "the required check cannot run here",
        evidence: "host check missing",
        citations: [],
      }),
    ),
  );
  assert.equal(result.verdicts.B, "rejected");
  assert.equal(result.verdicts.A, undefined);
  assert.equal(result.verdicts.C, undefined);
  assert.ok(result.timeline.some((entry) => entry.step === "blocked"));
});

test("contract: only resolvable citations plus complete passing checks admit no-change", async () => {
  const worker = async (_task: string, frozen: FrozenPatchWork) =>
    JSON.stringify({
      digest: frozen.digest,
      kind: "conclusion",
      conclusion: "no-change-needed",
      summary: "bounded claim",
      evidence: "host reviewed fixed assertion",
      citations: [{ case: "stale", test: "a" }],
    });
  for (const status of ["passed", "failed", "skipped"]) {
    const result = await runCycle({
      ...options(worker, async () => ({
        verdict: "accept",
        outcomes: [{ label: "fixed", status }],
      })),
      noChangeCases: { B: [{ name: "stale", token: "stale" }] },
    });
    assert.equal(result.verdicts.B, status === "passed" ? "accepted" : "rejected");
  }
  const noCases = await runCycle(options(worker));
  assert.equal(noCases.verdicts.B, "rejected", "without host-frozen cases nothing is claimable");
  const empty = await runCycle({
    ...options(worker),
    checks: [],
    noChangeCases: { B: [{ name: "stale", token: "stale" }] },
  });
  assert.equal(empty.verdicts.B, "rejected", "an empty check set cannot admit a claim");
});

test("contract: a patch proves a case only by naming its frozen title token", async () => {
  const patch = (content: string) => async (_task: string, frozen: FrozenPatchWork) =>
    JSON.stringify({ digest: frozen.digest, files: [{ path: TESTS, content }] });
  const rules = { B: [{ name: "late-result-after-cancellation", token: "cancellation" }] };
  const named = await runCycle({
    ...options(
      patch("test('a', () => {}); test('rejects a result after cancellation', () => {});\n"),
    ),
    noChangeCases: rules,
  });
  assert.equal(named.verdicts.B, "accepted");
  const unnamed = await runCycle({
    ...options(patch("test('a', () => {}); test('tests a late result', () => {});\n")),
    noChangeCases: rules,
  });
  assert.equal(unnamed.verdicts.B, "rejected");
  assert.ok(unnamed.timeline.some((entry) => entry.step === "case-unresolved"));
  // An unstated token is never guessed: the same patch fails without one.
  const noToken = await runCycle({
    ...options(
      patch("test('a', () => {}); test('rejects a result after cancellation', () => {});\n"),
    ),
    noChangeCases: { B: [{ name: "late-result-after-cancellation", token: "" }] },
  });
  assert.equal(noToken.verdicts.B, "rejected");
});

test("contract: a declared mutant the baseline already detects invalidates the premise", async () => {
  const dispatched: string[] = [];
  const optionsWith = () => ({
    ...options(async (task, frozen) => {
      dispatched.push(task);
      return JSON.stringify({
        digest: frozen.digest,
        files: [{ path: TESTS, content: "changed" }],
      });
    }),
    runChecks: async () => ({
      verdict: "reject" as const,
      outcomes: [{ label: "fixed", status: "failed" }],
    }),
    mutations: { B: [mutant("m1", "export const a = 2;\n")] },
  });
  // The check always rejects, so the declared mutant is "already detected"; the
  // premise is false and the round fails closed instead of crashing or accepting.
  const result = await runCycle(optionsWith());
  assert.equal(result.verdicts.B, "rejected");
  assert.deepEqual(result.accepted, {});
  assert.ok(result.timeline.some((entry) => entry.step === "precondition-failed"));
  assert.ok(result.timeline.some((entry) => entry.step === "premise-invalid"));
  // The premise gates the *dispatch*, not only the acceptance: a false premise must not
  // spend a model call on work the host will refuse on its own evidence.
  assert.ok(!dispatched.includes("B"), `B was dispatched anyway: ${JSON.stringify(dispatched)}`);
  assert.ok(result.rejections.some((item) => item.task === "B" && item.attempt === 0));
});

test("contract: a patch is accepted only when it passes intact and kills a declared mutant", async () => {
  const patch = (content: string) => async (_task: string, frozen: FrozenPatchWork) =>
    JSON.stringify({ digest: frozen.digest, files: [{ path: TESTS, content }] });
  const withMutant = (content: string) => ({
    ...options(patch(content), mutationRunner),
    mutations: { B: [mutant("m1", "export const a = 1; // MUTANT\n")] },
  });
  // Passes intact, fails on the mutant: the gap is closed, so this is accepted.
  const closing = await runCycle(withMutant("test('a', () => {}); // detects-mutant\n"));
  assert.equal(closing.verdicts.B, "accepted");
  assert.deepEqual(closing.killed.B, ["m1"]);
  assert.deepEqual(closing.survived.B ?? [], []);
  // Passes both: the test does not detect the fault, so it proves nothing.
  const useless = await runCycle(withMutant("test('a', () => {}); // no detection\n"));
  assert.equal(useless.verdicts.B, "rejected");
  assert.ok(useless.timeline.some((entry) => entry.step === "gap-not-closed"));
  assert.deepEqual(useless.survived.B, ["m1"]);
  // A candidate that does not pass intact is rejected before any mutant runs.
  const broken = await runCycle(withMutant("BROKEN // detects-mutant\n"));
  assert.equal(broken.verdicts.B, "rejected");
  assert.equal(broken.killed.B, undefined);
});

test("contract: proven-gap mode replaces the title-token rule instead of stacking with it", async () => {
  const result = await runCycle({
    ...options(
      async (_task, frozen) =>
        JSON.stringify({
          digest: frozen.digest,
          files: [{ path: TESTS, content: "test('a', () => {}); // detects-mutant\n" }],
        }),
      mutationRunner,
    ),
    // A title token the candidate cannot satisfy, plus a mutant it does satisfy.
    noChangeCases: { B: [{ name: "artifact-escapes-scope", token: "escap" }] },
    mutations: { B: [mutant("m1", "export const a = 1; // MUTANT\n")] },
  });
  assert.equal(result.verdicts.B, "accepted");
  assert.ok(!result.timeline.some((entry) => entry.step === "case-unresolved"));
  assert.deepEqual(result.killed.B, ["m1"]);
});

test("contract: a declared mutant is stated in the frozen instruction, so the worker can target it", async () => {
  let instruction = "";
  const result = await runCycle({
    ...options(async (taskId, frozen) => {
      if (taskId === "B") instruction = frozen.work.instruction;
      return JSON.stringify({
        digest: frozen.digest,
        files: [{ path: TESTS, content: "test('a', () => {}); // detects-mutant\n" }],
      });
    }, mutationRunner),
    mutations: { B: [mutant("m1", "export const a = 1; // MUTANT\n")] },
  });
  assert.equal(result.verdicts.B, "accepted");
  assert.match(instruction, /"id":"m1"/);
  assert.match(instruction, /export const a = 1; \/\/ MUTANT/);
});

test("safety: a proven surviving mutant makes a no-change conclusion false", async () => {
  const conclusion = async (_task: string, frozen: FrozenPatchWork) =>
    JSON.stringify({
      digest: frozen.digest,
      kind: "conclusion",
      conclusion: "no-change-needed",
      summary: "already covered",
      evidence: "cited title exists",
      citations: [{ case: "stale", test: "a" }],
    });
  const resolved = await runCycle({
    ...options(conclusion, mutationRunner),
    noChangeCases: { B: [{ name: "stale", token: "stale" }] },
  });
  assert.equal(resolved.verdicts.B, "accepted", "a resolved citation is enough without mutants");
  const proven = await runCycle({
    ...options(conclusion, mutationRunner),
    noChangeCases: { B: [{ name: "stale", token: "stale" }] },
    mutations: { B: [mutant("m1", "export const a = 1; // MUTANT\n")] },
  });
  assert.equal(proven.verdicts.B, "rejected");
  assert.ok(proven.timeline.some((entry) => entry.step === "gap-proven"));
});

test("contract: a declared precondition unmet by the accepted artifact reopens its producer", async () => {
  let aRuns = 0;
  const result = await runCycle({
    ...options(async (taskId, frozen) => {
      if (taskId === "C")
        return JSON.stringify({
          digest: frozen.digest,
          kind: "conclusion",
          conclusion: "promote-candidate",
          summary: "composed",
          evidence: "host check",
          citations: [],
        });
      if (taskId === "A") {
        aRuns += 1;
        // The first attempt produces an artifact that does not satisfy the declared
        // requirement; only the reopened attempt adds the required test title.
        const content = aRuns === 1 ? "plain\n" : "test('guards the protocol', () => {});\n";
        return JSON.stringify({ digest: frozen.digest, files: [{ path: IMPL, content }] });
      }
      return JSON.stringify({
        digest: frozen.digest,
        files: [{ path: TESTS, content: `test('b', () => {});\n` }],
      });
    }),
    requires: { C: [{ kind: "test-title", task: "A", token: "guards the protocol" }] },
  });
  assert.equal(aRuns, 2, "A ran once, was reopened, and ran again");
  assert.equal(result.verdicts.A, "accepted");
  assert.equal(result.verdicts.C, "accepted");
  assert.equal(result.measurements.reopens.length, 1);
  const steps = result.timeline.map((entry) => entry.step);
  assert.ok(steps.includes("dependency-rejected"));
  assert.ok(steps.includes("reopen"));
  // The reopened attempt gets fresh check evidence bound to the new input.
  assert.equal(steps.filter((step) => step === "check-issued").length, 2);
  assert.equal(result.composed.verdict, "accept");
});

test("safety: exhausting the reopen budget blocks the dependent instead of looping", async () => {
  const result = await runCycle({
    ...options(async (taskId, frozen) =>
      taskId === "C"
        ? JSON.stringify({
            digest: frozen.digest,
            kind: "conclusion",
            conclusion: "promote-candidate",
            summary: "composed",
            evidence: "host check",
            citations: [],
          })
        : JSON.stringify({
            digest: frozen.digest,
            files: [
              {
                path: taskId === "A" ? IMPL : TESTS,
                content: "still missing the requirement\n",
              },
            ],
          }),
    ),
    requires: { C: [{ kind: "test-title", task: "A", token: "never-appears" }] },
    maxReopens: 1,
  });
  assert.equal(result.measurements.reopens.length, 1);
  assert.equal(result.verdicts.C, "blocked");
  assert.ok(result.timeline.some((entry) => entry.step === "reopen-exhausted"));
});

test("contract: the round reports what the out-of-order task hid and what the host spent", async () => {
  const result = await runCycle(
    options(async (_task, frozen) => ({
      artifact: JSON.stringify({
        digest: frozen.digest,
        files: [{ path: TESTS, content: "test('a', () => {}); test('c', () => {});\n" }],
      }),
      metrics: { tokens: 1_234, turns: 3, checks: 1 },
    })),
  );
  assert.deepEqual(result.measurements.workers.B, {
    tokens: 1_234,
    turns: 3,
    checks: 1,
    ms: result.measurements.workers.B.ms,
  });
  assert.ok(result.measurements.workers.B.ms >= 0);
  assert.ok(result.measurements.hiddenWaitMs >= 0);
  assert.ok(result.measurements.hostChecks > 0);
  assert.ok(result.measurements.hostMs >= 0);
  assert.deepEqual(result.measurements.reopens, []);
});

test("contract: a mid-attempt pushback ends the dependent and reopens the named dependency", async () => {
  const cRuns: number[] = [];
  let aRuns = 0;
  const requirement = "A adds a test titled *plain* that really asserts the protocol";
  const result = await runCycle({
    ...options(async (taskId, frozen) => {
      if (taskId === "C") {
        cRuns.push(aRuns);
        // The host can see the required title, so it lets C start; only C can discover
        // that the placeholder test does not assert what the requirement means.
        if (cRuns.length === 1)
          return {
            artifact: "",
            pushback: {
              dependency: "A",
              requirement,
              evidence: "the only matching test is a placeholder with no assertions",
            },
          };
        return JSON.stringify({
          digest: frozen.digest,
          kind: "conclusion",
          conclusion: "promote-candidate",
          summary: "the reopened artifact satisfies the requirement",
          evidence: "the new title asserts the protocol",
          citations: [],
        });
      }
      if (taskId === "A") {
        aRuns += 1;
        return JSON.stringify({
          digest: frozen.digest,
          files: [
            {
              path: IMPL,
              content:
                aRuns === 1
                  ? "test('plain placeholder', () => {});\n"
                  : "test('plain', () => { assert.equal(1, 1); });\n",
            },
          ],
        });
      }
      return JSON.stringify({
        digest: frozen.digest,
        files: [{ path: TESTS, content: "test('b', () => {});\n" }],
      });
    }),
    requires: { C: [{ kind: "test-title", task: "A", token: "plain" }] },
  });
  assert.equal(cRuns.length, 2, "C ran, pushed back, and ran again");
  assert.equal(aRuns, 2, "the reopen made A run again with the consumer's evidence");
  assert.equal(result.measurements.reopens.length, 1);
  assert.ok(result.timeline.some((entry) => entry.step === "pushback:C"));
  assert.ok(result.timeline.some((entry) => entry.step === "reopen"));
  assert.equal(result.verdicts.A, "accepted");
  assert.equal(result.verdicts.C, "accepted");
});

const cleanCandidate = async (taskId: string, frozen: FrozenPatchWork) => {
  if (taskId === "C")
    return JSON.stringify({
      digest: frozen.digest,
      kind: "conclusion",
      conclusion: "no-change-needed",
      summary: "Nothing to promote",
      evidence: "no accepted patch in this round",
      citations: [],
    });
  return JSON.stringify({
    digest: frozen.digest,
    files: [{ path: taskId === "A" ? IMPL : TESTS, content: `changed by ${taskId}` }],
  });
};

test("safety: stub workers cannot self-approve, and C cannot promote a rejected composition", async () => {
  const selfApproved = await runCycle(
    options(async (taskId, frozen) => {
      const path = taskId === "A" ? IMPL : TESTS;
      const extra = taskId === "A" ? { passed: true, verdict: "accept" } : {};
      return JSON.stringify({
        digest: frozen.digest,
        files: [{ path, content: "changed" }],
        ...extra,
      });
    }),
  );
  assert.equal(selfApproved.verdicts.B, "accepted");
  assert.equal(selfApproved.verdicts.A, "rejected");
  assert.equal(selfApproved.verdicts.C, undefined);
  assert.deepEqual(Object.keys(selfApproved.accepted), ["B"]);

  const wrongConclusion = await runCycle(options(cleanCandidate));
  assert.equal(wrongConclusion.verdicts.A, "accepted");
  assert.equal(wrongConclusion.verdicts.C, "rejected");
});

test("safety: an artifact carrying the pre-check digest is rejected, not accepted", async () => {
  const stale = preparePatchWork({
    taskId: "A",
    attempt: 1,
    instruction: "pre-check instruction",
    files: baseline,
    editable: [IMPL],
    budget: { perFile: 20_000, output: 40_000 },
    limits: { turns: 4, reads: 3, timeoutMs: 60_000 },
  });
  const result = await runCycle(
    options(async (taskId, frozen) => {
      const digest = taskId === "A" ? stale.digest : frozen.digest;
      return JSON.stringify({
        digest,
        files: [{ path: taskId === "A" ? IMPL : TESTS, content: "changed" }],
      });
    }),
  );
  assert.equal(result.verdicts.B, "accepted");
  assert.equal(result.verdicts.A, "rejected");
  assert.equal(result.verdicts.C, undefined);
  assert.deepEqual(Object.keys(result.accepted), ["B"]);
});

test("safety: a premise that could not be measured is refused as unmeasured, not as detected", async () => {
  const dispatched: string[] = [];
  let calls = 0;
  const result = await runCycle({
    ...options(async (task, frozen) => {
      dispatched.push(task);
      return JSON.stringify({
        digest: frozen.digest,
        files: [{ path: TESTS, content: "changed" }],
      });
    }),
    // The mutant measurement cannot run at all: no result is a missing premise, never
    // evidence that the fault is already covered.
    runChecks: async ({ files }) => {
      calls += 1;
      return Object.values(files).some((text) => text.includes("MUTANT"))
        ? {
            verdict: "undecidable" as const,
            outcomes: [{ label: "fixed", status: "undecidable" as const }],
          }
        : { verdict: "accept" as const, outcomes: [{ label: "fixed", status: "passed" as const }] };
    },
    mutations: { B: [mutant("m1", "export const a = 1; // MUTANT\n")] },
  });
  assert.ok(calls > 0, "the premise proof must actually run");
  assert.equal(result.verdicts.B, "rejected");
  assert.ok(result.timeline.some((entry) => entry.step === "premise-unmeasured"));
  assert.ok(!result.timeline.some((entry) => entry.step === "precondition-failed"));
  assert.ok(!dispatched.includes("B"), "an unproven premise must not spend a model call");
  assert.ok(
    result.log.some((event) => event.kind === "mutant" && event.outcome === "unmeasured"),
    JSON.stringify(result.log.filter((event) => event.kind === "mutant")),
  );
});

/** Real CPU work for a chosen duration, in a real child process: not a sleep, so the overlap
 *  measured here is real work overlapping real work. */
const busy = (ms: number): string =>
  `const end=Date.now()+${ms};let a=1;while(Date.now()<end){a=(a*16807)%2147483647;}if(a<=0)process.exit(3);`;

const work = (ms: number) => (ms > 0 ? run(process.execPath, ["-e", busy(ms)]) : Promise.resolve());

test("the hidden wait is the independent task's own work, not its later verification", async () => {
  // The check is longer than the task's own work, while the task's verification (the candidate
  // check the host runs afterwards) is longer still. Counting claim-to-submission therefore
  // reports the whole check as hidden; counting claim-to-return reports what the task really
  // covered. Only the second answer is the wait that out-of-order execution hid.
  const checkMs = 1_500;
  const taskMs = 200;
  const slow: CheckRunner = async () => {
    await work(checkMs);
    return { verdict: "accept", outcomes: [{ label: "fixed", status: "passed" }] };
  };
  const result = await runCycle(
    options(async (taskId, frozen) => {
      if (taskId === "B") await work(taskMs);
      if (taskId === "A")
        return JSON.stringify({
          digest: frozen.digest,
          files: [{ path: IMPL, content: "export const a = 2;\n" }],
        });
      if (taskId === "B")
        return JSON.stringify({
          digest: frozen.digest,
          files: [{ path: TESTS, content: "test('a', () => {}); test('b', () => {});\n" }],
        });
      return JSON.stringify({
        digest: frozen.digest,
        kind: "conclusion",
        conclusion: "promote-candidate",
        summary: "composed check passed",
        evidence: "candidate-check accept",
        citations: [],
      });
    }, slow),
  );
  assert.deepEqual(result.verdicts, { B: "accepted", A: "accepted", C: "accepted" });
  const { hiddenWaitMs } = result.measurements;
  assert.ok(
    hiddenWaitMs < taskMs + 400,
    `hidden wait ${hiddenWaitMs} ms must be bounded by B's own work (${taskMs} ms), not by the ${checkMs} ms check or by B's verification`,
  );
  assert.ok(
    hiddenWaitMs > taskMs / 2,
    `a real overlap should still be reported, got ${hiddenWaitMs}`,
  );
});

test("with nothing independent to overlap, nothing is reported as hidden", async () => {
  // The old definition reported the check's own window here (a few hundred milliseconds of
  // dispatch and verification) even though no work was overlapped at all.
  const result = await runCycle(
    options(
      async (taskId, frozen) => {
        if (taskId === "A")
          return JSON.stringify({
            digest: frozen.digest,
            files: [{ path: IMPL, content: "export const a = 2;\n" }],
          });
        if (taskId === "B")
          return JSON.stringify({
            digest: frozen.digest,
            files: [{ path: TESTS, content: "test('a', () => {}); test('b', () => {});\n" }],
          });
        return JSON.stringify({
          digest: frozen.digest,
          kind: "conclusion",
          conclusion: "promote-candidate",
          summary: "composed check passed",
          evidence: "candidate-check accept",
          citations: [],
        });
      },
      async () => ({ verdict: "accept", outcomes: [{ label: "fixed", status: "passed" }] }),
    ),
  );
  assert.ok(
    result.measurements.hiddenWaitMs < 100,
    `no independent work ran, so hidden wait must be ~0, got ${result.measurements.hiddenWaitMs}`,
  );
});
