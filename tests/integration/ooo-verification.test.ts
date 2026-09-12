import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ARTIFACT_TOOL,
  artifactEnvelope,
  artifactFromText,
  checkToolCandidate,
  resourceLoader,
  piCompletionAllowed,
  snapshotText,
} from "../../.pi/extensions/nmg/ooo-execution.ts";
import { patchPrompt, preparePatchWork } from "../../src/integration/ooo-patch.ts";
import { expectedRename, verifyRenameCandidate } from "../../evals/ooo-execution/patch-verifier.ts";
import { mutate } from "../../evals/ooo-execution/mutation.ts";

const patchWorkFields = () => ({
  taskId: "run-1:A",
  attempt: 1,
  instruction: "Repair the check.",
  files: { "src/check.ts": "export const a = 1;\n", "src/check.test.ts": "old\n" },
  editable: ["src/check.test.ts"],
  budget: { perFile: 8_000, output: 8_000 },
  limits: { turns: 4, reads: 2, timeoutMs: 60_000 },
});

const patchWork = () =>
  preparePatchWork({
    taskId: "round:B",
    attempt: 1,
    instruction: "add a regression test",
    files: { "src/check.ts": "export const a = 1;\n", "src/check.test.ts": "old\n" },
    editable: ["src/check.test.ts"],
    budget: { perFile: 8_000, output: 8_000 },
    limits: { turns: 4, reads: 2, timeoutMs: 60_000 },
  });

test("contract: the artifact tool builds the exact envelope the shared contract accepts", () => {
  const frozen = patchWork();
  const patched = artifactEnvelope(frozen, {
    digest: frozen.digest,
    files: [{ path: "src/check.test.ts", content: "new\n" }],
  });
  assert.equal(patched.ok, true);
  assert.deepEqual(JSON.parse(patched.ok ? patched.json : "{}"), {
    digest: frozen.digest,
    files: [{ path: "src/check.test.ts", content: "new\n" }],
  });
  const conclusion = artifactEnvelope(frozen, {
    digest: frozen.digest,
    conclusion: "no-change-needed",
    summary: "already covered",
    evidence: "cited title exists",
    citations: [{ case: "stale", test: "rejects a stale check" }],
  });
  assert.deepEqual(JSON.parse(conclusion.ok ? conclusion.json : "{}"), {
    digest: frozen.digest,
    kind: "conclusion",
    conclusion: "no-change-needed",
    summary: "already covered",
    evidence: "cited title exists",
    citations: [{ case: "stale", test: "rejects a stale check" }],
  });
  // A wrong digest, a mixed answer and an incomplete conclusion come back as a
  // correctable error instead of a silently invalid artifact.
  for (const params of [
    { digest: "f".repeat(64), files: [{ path: "src/check.test.ts", content: "x" }] },
    {
      digest: frozen.digest,
      files: [{ path: "src/check.test.ts", content: "x" }],
      conclusion: "no-change-needed",
    },
    { digest: frozen.digest, conclusion: "no-change-needed" },
  ]) {
    const outcome = artifactEnvelope(frozen, params);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.ok === false && outcome.error.length > 0);
  }
});

test("contract: the compiled prompt states the constraint once and names the artifact tool", () => {
  const frozen = patchWork();
  const compiled = patchPrompt(frozen, ARTIFACT_TOOL);
  assert.ok(compiled.includes(ARTIFACT_TOOL));
  assert.ok(compiled.includes(frozen.digest));
  // The shape enumeration and its restatements are the stacked constraints this removed.
  assert.ok(!compiled.includes("Shape 1"));
  assert.ok(!compiled.includes("no code fences"));
  // The text fallback still carries the shapes for callers without the tool.
  const fallback = patchPrompt(frozen);
  assert.ok(fallback.includes("Shape 1") && fallback.includes("Shape 2"));
});

test("safety: the worker's check tool validates proposed files through the shared contract", () => {
  const frozen = patchWork();
  assert.deepEqual(checkToolCandidate(frozen, [{ path: "src/check.test.ts", content: "new\n" }]), {
    "src/check.ts": "export const a = 1;\n",
    "src/check.test.ts": "new\n",
  });
  for (const files of [
    [{ path: "src/integration/ooo-check.ts", content: "injected\n" }],
    [{ path: "../outside.ts", content: "injected\n" }],
    [{ path: "src/check.test.ts", content: "old\n" }],
    [],
    [
      { path: "src/check.test.ts", content: "a\n" },
      { path: "src/check.test.ts", content: "b\n" },
    ],
    [{ path: "src/check.test.ts", content: "x".repeat(9_000) }],
  ])
    assert.throws(() => checkToolCandidate(frozen, files));
});

test("safety: a mutant is applied fail-closed and detects its own anchor", () => {
  const files = { "src/check.ts": "export const a = 1;\n" };
  const mutation = { id: "m1", path: "src/check.ts", from: "a = 1", to: "a = 2" };
  assert.deepEqual(mutate(files, mutation), { "src/check.ts": "export const a = 2;\n" });
  assert.deepEqual(files, { "src/check.ts": "export const a = 1;\n" });
  for (const bad of [
    { ...mutation, id: "absent", from: "nope" },
    { ...mutation, id: "ambiguous", path: "src/check.ts", from: "o", to: "0" },
    { ...mutation, id: "noop", from: "a = 1", to: "a = 1" },
    { ...mutation, id: "missing-path", path: "src/other.ts" },
  ])
    assert.throws(() => mutate(files, bad));
});

test("safety: failed or incomplete Pi turns cannot return accepted artifacts after a read", () => {
  assert.equal(piCompletionAllowed("stop", false, 2, 1), true);
  for (const reason of ["error", "aborted", "length", "toolUse", undefined])
    assert.equal(piCompletionAllowed(reason, false, 2, 1), false);
  assert.equal(piCompletionAllowed("stop", true, 2, 1), false);
  for (const turns of [0, 4]) assert.equal(piCompletionAllowed("stop", false, turns, 1), false);
  for (const reads of [0, 3]) assert.equal(piCompletionAllowed("stop", false, 2, reads), false);
});

test("contract: the worker's check budget is host-limited, not model-chosen", () => {
  const limits = { turns: 8, reads: 2, timeoutMs: 60_000 };
  assert.equal(piCompletionAllowed("stop", false, 3, 1), true);
  assert.equal(piCompletionAllowed("stop", false, limits.turns + 1, 1, limits), false);
  assert.equal(piCompletionAllowed("stop", false, 3, limits.reads + 1, limits), false);
});

test("contract: candidate directory check reports a real terminal event without modifying source", async () => {
  const path = new URL("../../src/integration/ooo-execution.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const result = await verifyRenameCandidate(source, expectedRename(source));
  assert.equal(result.verdict, "accept");
  assert.ok(result.checkId);
  assert.ok(result.startedAt && result.finishedAt && result.finishedAt >= result.startedAt);
  assert.equal(readFileSync(path, "utf8"), source);
  assert.equal(
    (await verifyRenameCandidate(source, expectedRename(source) + "\n//extra")).verdict,
    "reject",
  );
  const invalid = source + "\nfunction broken( {";
  assert.equal((await verifyRenameCandidate(invalid, expectedRename(invalid))).verdict, "reject");
});

test("safety: rename oracle rejects unrelated changes which passed the old substring check", () => {
  const source = readFileSync(
    new URL("../../src/integration/ooo-execution.ts", import.meta.url),
    "utf8",
  );
  const expected = expectedRename(source);
  assert.notEqual(expected, source);
  for (const candidate of [
    expected + "\n// unrelated",
    expected.replace("return null;", "return 'unsafe';"),
    expected.replace("export interface SnapshotWork", "interface SnapshotWork"),
  ]) {
    assert.ok(candidate.includes("planIndex") && !candidate.includes("byId"));
    assert.notEqual(candidate, expected);
  }
  const prefix = "// byId outside the target stays unchanged\n";
  assert.equal(expectedRename(prefix + source), prefix + expected);
  assert.throws(() => expectedRename("missing function"));
  assert.throws(() => expectedRename(expected));
  assert.throws(() => expectedRename(source + "\nexport const another = 1;"));
});

test("scope: the snapshot carries the readable subset only, and names what is hidden", () => {
  const frozen = preparePatchWork({
    taskId: "run-1:A",
    attempt: 1,
    instruction: "Repair the check.",
    files: {
      "src/integration/ooo-check.ts": "export const a = 1;\n",
      "src/integration/ooo-patch.ts": "export const big = 1;\n",
    },
    editable: ["src/integration/ooo-check.ts"],
    visible: ["src/integration/ooo-check.ts"],
  });
  const snapshot = JSON.parse(snapshotText(frozen)) as {
    files: Record<string, string>;
    hidden?: string[];
  };
  assert.deepEqual(Object.keys(snapshot.files), ["src/integration/ooo-check.ts"]);
  assert.deepEqual(snapshot.hidden, ["src/integration/ooo-patch.ts"]);
  const prompt = patchPrompt(frozen, ARTIFACT_TOOL);
  // What is frozen but not shown is stated, so narrowing the view is never a hidden rule.
  assert.ok(prompt.includes("Frozen but not shown"));
  assert.ok(prompt.includes("src/integration/ooo-patch.ts"));
  // An unscoped task says nothing about hidden files and ships the whole baseline.
  const whole = preparePatchWork({
    taskId: "run-1:B",
    attempt: 1,
    instruction: "Add a regression.",
    files: { "src/integration/ooo-check.ts": "export const a = 1;\n" },
    editable: ["src/integration/ooo-check.ts"],
  });
  assert.ok(!patchPrompt(whole, ARTIFACT_TOOL).includes("Frozen but not shown"));
  assert.ok(snapshotText(whole).includes('"hidden"') === false);
});

test("contract: an invented conclusion value is refused, not forwarded to the host", () => {
  // Live regression: a worker answered kind="no-change" with a prose conclusion, the
  // envelope passed both through, and the host rejected it as an invalid structure.
  // Presence is not validity: the kind of conclusion is an enum, and the discriminator
  // is the tool's own shape, so neither can be invented.
  const frozen = patchWork();
  const invented = artifactEnvelope(frozen, {
    digest: frozen.digest,
    conclusion: "no-change",
    summary: "nothing to do",
    evidence: "check passed",
  });
  assert.equal(invented.ok, false);
  assert.match(invented.ok ? "" : invented.error, /conclusion must be one of/);
  const prose = artifactEnvelope(frozen, {
    digest: frozen.digest,
    conclusion: "No defect inside the editable file is exposed; see the title below.",
    summary: "nothing to do",
    evidence: "check passed",
  });
  assert.equal(prose.ok, false);
  const blank = artifactEnvelope(frozen, {
    digest: frozen.digest,
    conclusion: "no-change-needed",
    summary: "   ",
    evidence: "check passed",
  });
  assert.match(blank.ok ? "" : blank.error, /missing or empty summary/);
  const badCitation = artifactEnvelope(frozen, {
    digest: frozen.digest,
    conclusion: "no-change-needed",
    summary: "covered",
    evidence: "cited",
    citations: [{ case: "stale", test: "   " }],
  });
  assert.match(badCitation.ok ? "" : badCitation.error, /non-empty case and test/);
});

test("channel: the envelope refuses a kind the frozen rule does not admit", () => {
  const frozen = preparePatchWork({
    ...patchWorkFields(),
    admittedConclusions: ["cannot-complete"],
  });
  const promoted = artifactEnvelope(frozen, {
    digest: frozen.digest,
    conclusion: "promote-candidate",
    summary: "composed",
    evidence: "check passed",
  });
  assert.equal(promoted.ok, false);
  assert.match(promoted.ok ? "" : promoted.error, /conclusion must be one of cannot-complete/);
  const blocked = artifactEnvelope(frozen, {
    digest: frozen.digest,
    conclusion: "cannot-complete",
    summary: "blocked",
    evidence: "dependency missing",
  });
  assert.equal(blocked.ok, true);
});

test("contract: a text answer obeys the tool's envelope, or the attempt fails with a reason", () => {
  const frozen = patchWork();
  // A patch written as text is normalised to the same envelope the tool produces.
  const asText = artifactFromText(
    frozen,
    JSON.stringify({
      digest: frozen.digest,
      files: [{ path: "src/check.test.ts", content: "new\n" }],
    }),
  );
  assert.deepEqual(JSON.parse(asText.ok ? asText.json : "{}"), {
    digest: frozen.digest,
    files: [{ path: "src/check.test.ts", content: "new\n" }],
  });
  // The shape a live round actually returned: conclusion fields, no files, null kind.
  const unshaped = artifactFromText(
    frozen,
    JSON.stringify({
      digest: frozen.digest,
      summary: "added tests",
      evidence: "...",
      conclusion: null,
      citations: [],
    }),
  );
  assert.equal(unshaped.ok, false);
  assert.match(errorOf(unshaped), /provide files, or a conclusion/);
  // A wrong digest is named rather than passed to the host to refuse later.
  const stale = artifactFromText(frozen, JSON.stringify({ digest: "0".repeat(64), files: [] }));
  assert.equal(stale.ok, false);
  assert.match(errorOf(stale), /digest must be exactly/);
  assert.equal(artifactFromText(frozen, "I added the missing test.").ok, false);
});

/** The refusal text of a validator result, with the union narrowed once. */
const errorOf = (result: ReturnType<typeof artifactFromText>): string => {
  assert.equal(result.ok, false);
  return result.ok ? "" : result.error;
};

test("contract: a patch attempt is told to answer through the artifact tool, not in prose", () => {
  const patchMode = resourceLoader(true).getSystemPrompt() ?? "";
  assert.match(patchMode, /calling the artifact tool/);
  assert.doesNotMatch(patchMode, /must begin with '\{'/);
  // The snapshot task has no envelope and keeps the JSON-in-text instruction.
  const snapshotMode = resourceLoader(false).getSystemPrompt() ?? "";
  assert.match(snapshotMode, /must begin with '\{'/);
});
