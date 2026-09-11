import assert from "node:assert/strict";
import test from "node:test";
import {
  preparePatchWork,
  patchCandidate,
  patchPrompt,
  patchSubmission,
} from "../../src/integration/ooo-patch.ts";

const work = () => ({
  taskId: "run-1:A",
  attempt: 1,
  instruction: "Change the exported value to two.",
  files: { "src/value.ts": "export const value = 1;\n", "README.md": "Read only" },
  editable: ["src/value.ts"],
});
const artifact = (digest: string, path = "src/value.ts", content = "export const value = 2;\n") =>
  JSON.stringify({ digest, files: [{ path, content }] });

test("contract: the prompt pre-fills the real digest, editable paths and citation shape", () => {
  const frozen = preparePatchWork(work());
  const prompt = patchPrompt(frozen);
  // The digest and editable list are host-owned facts, so the worker never has to
  // restate them; prose answers were the live-round failure this removes.
  assert.ok(prompt.includes(`"digest":"${frozen.digest}"`));
  assert.ok(prompt.includes(JSON.stringify(frozen.work.editable)));
  assert.ok(prompt.includes('"citations":[{"case"'));
  assert.ok(prompt.includes(`${frozen.work.budget.output} UTF-8 bytes`));
  assert.ok(!prompt.includes("the supplied digest"));
});

test("contract: a frozen patch produces detached candidate text, not a disk write or completion", () => {
  const input = work();
  const frozen = preparePatchWork(input);
  input.files["src/value.ts"] = "mutated";
  input.editable.push("README.md");
  const candidate = patchCandidate(frozen, artifact(frozen.digest));
  assert.equal(candidate["src/value.ts"], "export const value = 2;\n");
  assert.equal(candidate["README.md"], "Read only");
  assert.equal(frozen.work.files["src/value.ts"], "export const value = 1;\n");
  assert.ok(Object.isFrozen(frozen.work.files));
  assert.ok(Object.isFrozen(candidate));
});

test("safety: identity, attempt, instruction, permissions and source changes invalidate an artifact", () => {
  const original = preparePatchWork(work());
  for (const change of [
    { taskId: "run-2:A" },
    { attempt: 2 },
    { instruction: "Different task" },
    { editable: ["README.md"] },
    { files: { ...work().files, "README.md": "Changed" } },
  ]) {
    const current = preparePatchWork({ ...work(), ...change });
    assert.throws(() => patchCandidate(current, artifact(original.digest)), /digest/);
  }
});

test("safety: paths cannot traverse, alias Windows devices, or collide by case", () => {
  for (const path of [
    "../x",
    "/x",
    "C:/x",
    "a\\b",
    "a/../b",
    "a//b",
    "a/./b",
    "a.",
    "NUL.txt",
    "aux/x",
    "x:stream",
    "x\u0000",
    "__proto__",
  ]) {
    assert.throws(
      () => preparePatchWork({ ...work(), files: { [path]: "x" }, editable: [path] }),
      /path/,
    );
  }
  assert.throws(
    () => preparePatchWork({ ...work(), files: { "a.ts": "a", "A.ts": "b" }, editable: ["a.ts"] }),
    /path/,
  );
});

test("safety: malformed, duplicate, unauthorized and empty patches fail closed", () => {
  const frozen = preparePatchWork(work());
  const entry = { path: "src/value.ts", content: "changed" };
  for (const value of [
    null,
    [],
    {},
    { digest: frozen.digest, files: [] },
    { digest: frozen.digest, files: [entry, entry] },
    { digest: frozen.digest, files: [{ ...entry, passed: true }] },
    { digest: frozen.digest, files: [entry], passed: true },
    { digest: frozen.digest, files: [{ ...entry, content: null }] },
  ])
    assert.throws(() => patchCandidate(frozen, JSON.stringify(value)));
  for (const path of ["README.md", "new.ts", "../escape", "SRC/value.ts"])
    assert.throws(() => patchCandidate(frozen, artifact(frozen.digest, path)));
  assert.throws(
    () =>
      patchCandidate(frozen, artifact(frozen.digest, "src/value.ts", work().files["src/value.ts"])),
    /unchanged/,
  );
  assert.throws(() => patchCandidate(frozen, "```json\n{}\n```"));
});

test("safety: source and output budgets, invalid attempts and missing edit targets are rejected", () => {
  assert.throws(() => preparePatchWork({ ...work(), attempt: 0 }));
  assert.throws(() => preparePatchWork({ ...work(), editable: ["absent.ts"] }));
  assert.throws(() => preparePatchWork({ ...work(), editable: [] }));
  assert.throws(() => preparePatchWork({ ...work(), instruction: "x".repeat(4097) }));
  assert.throws(() =>
    preparePatchWork({ ...work(), files: { "src/value.ts": "x".repeat(64001) } }),
  );
  const frozen = preparePatchWork(work());
  assert.throws(
    () => patchCandidate(frozen, artifact(frozen.digest, "src/value.ts", "x".repeat(8001))),
    /budget/,
  );
  assert.throws(() => patchCandidate(frozen, artifact(frozen.digest, "src/value.ts", "\u0000")));
});

test("contract: budgets belong to the frozen envelope and cannot be raised by a worker", () => {
  const budget = { perFile: 20_000, output: 40_000 };
  const frozen = preparePatchWork({ ...work(), budget });
  assert.deepEqual(frozen.work.budget, budget);
  const big = "x".repeat(12_000);
  assert.equal(
    patchCandidate(frozen, artifact(frozen.digest, "src/value.ts", big))["src/value.ts"],
    big,
  );
  for (const invalid of [
    { perFile: 0, output: 10 },
    { perFile: 10, output: 5 },
    { perFile: 64_001, output: 64_001 },
  ])
    assert.throws(
      () => preparePatchWork({ ...work(), budget: invalid as typeof budget }),
      /budget/,
    );
  const changed = preparePatchWork({ ...work(), budget: { perFile: 20_000, output: 40_001 } });
  assert.notEqual(changed.digest, frozen.digest);
});

test("safety: a conclusion needs a matching digest, bounded text and no file content", () => {
  const frozen = preparePatchWork(work());
  const conclusion = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      digest: frozen.digest,
      kind: "conclusion",
      conclusion: "no-change-needed",
      summary: "checked",
      evidence: "check ran",
      citations: [{ case: "stale", test: "rejects a stale check" }],
      ...extra,
    });
  assert.deepEqual(patchSubmission(frozen, conclusion()), {
    kind: "conclusion",
    conclusion: "no-change-needed",
    summary: "checked",
    evidence: "check ran",
    citations: [{ case: "stale", test: "rejects a stale check" }],
  });
  assert.equal(patchSubmission(frozen, artifact(frozen.digest)).kind, "patch");
  for (const invalid of [
    conclusion({ digest: "f".repeat(64) }),
    conclusion({ conclusion: "looks-fine" }),
    conclusion({ summary: "" }),
    conclusion({ evidence: "" }),
    conclusion({ citations: [{ case: "", test: "a" }] }),
    conclusion({ citations: [{ case: "a", test: "" }] }),
    conclusion({ citations: [{ case: "a", test: "t", extra: 1 }] }),
    conclusion({ citations: "stale" }),
    conclusion({ files: [{ path: "src/value.ts", content: "x" }] }),
    JSON.stringify({ digest: frozen.digest, kind: "patch", files: [] }),
  ])
    assert.throws(() => patchSubmission(frozen, invalid));
  assert.throws(
    () =>
      patchSubmission(
        frozen,
        JSON.stringify({
          digest: frozen.digest,
          kind: "conclusion",
          conclusion: "cannot-complete",
          summary: "x".repeat(8_001),
          evidence: "e",
          citations: [],
        }),
      ),
    /budget/,
  );
});

test("scope: the readable subset is validated fail-closed", () => {
  // A file the worker may write but cannot read is a contradiction, and a path that is
  // not frozen cannot be shown; both must fail rather than silently widen or narrow.
  assert.throws(
    () => preparePatchWork({ ...work(), visible: ["README.md"] }),
    /editable path is hidden/,
  );
  assert.throws(
    () => preparePatchWork({ ...work(), visible: ["src/value.ts", "src/ghost.ts"] }),
    /visible path not frozen/,
  );
  assert.throws(() => preparePatchWork({ ...work(), visible: [] }), /invalid visible paths/);
  assert.throws(
    () => preparePatchWork({ ...work(), visible: ["README.md", "README.md"] }),
    /duplicate visible path/,
  );
});

test("scope: omission shows everything, and the digest ignores key order", () => {
  const frozen = preparePatchWork(work());
  assert.deepEqual(frozen.work.visible, ["README.md", "src/value.ts"]);
  // The default list is sorted, so two callers that insert the same files in a different
  // order agree on the digest; an unsorted default made that silently false.
  const reordered = preparePatchWork({
    ...work(),
    files: { "README.md": "Read only", "src/value.ts": "export const value = 1;\n" },
  });
  assert.equal(reordered.digest, frozen.digest);
  // A narrowed scope is part of the frozen input, so it changes the digest.
  const scoped = preparePatchWork({ ...work(), visible: ["src/value.ts"] });
  assert.notEqual(scoped.digest, frozen.digest);
  assert.deepEqual(scoped.work.visible, ["src/value.ts"]);
  // ...and the hidden file stays in the frozen work, so the host still verifies it.
  assert.ok(Object.hasOwn(scoped.work.files, "README.md"));
});

test("channel: a task is only offered the conclusion kinds its rule admits", () => {
  // A live round answered `promote-candidate` on a task that must return files: the
  // schema offered every kind, so the host had to reject. The admitted set is frozen
  // input, so it binds the digest and the tool schema derives from it.
  const all = preparePatchWork(work());
  assert.deepEqual([...all.work.admittedConclusions].sort(), [
    "cannot-complete",
    "no-change-needed",
    "promote-candidate",
  ]);
  const narrow = preparePatchWork({ ...work(), admittedConclusions: ["cannot-complete"] });
  assert.deepEqual(narrow.work.admittedConclusions, ["cannot-complete"]);
  assert.notEqual(narrow.digest, all.digest);
  assert.throws(
    () => preparePatchWork({ ...work(), admittedConclusions: [] }),
    /invalid admitted kinds/,
  );
  assert.throws(
    () => preparePatchWork({ ...work(), admittedConclusions: ["looks-fine"] as never }),
    /unknown admitted kind/,
  );
  assert.throws(
    () =>
      preparePatchWork({
        ...work(),
        admittedConclusions: ["cannot-complete", "cannot-complete"],
      }),
    /duplicate admitted kind/,
  );
});
