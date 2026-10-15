import assert from "node:assert/strict";
import test from "node:test";

import { decideMemoryLoad } from "../../src/core/gate.ts";
import { SessionRecallTrial } from "../../src/core/session-recall.ts";

function learn(trial: SessionRecallTrial, phrase = "老规矩", session = "a", project = "/project") {
  const prepared = trial.prepare(session, project, `Apply ${phrase}`);
  assert.equal(prepared.status, "skipped");
  return trial.correct(
    session,
    prepared.revision,
    phrase,
    "The query depends on a past preference.",
  );
}

// Contract: explicit weak intent proposals change only the shallow entry decision.
test("a corrected implicit query reuses the ordinary cue budget without rewriting static rules", () => {
  const trial = new SessionRecallTrial();
  assert.equal(decideMemoryLoad("Apply 老规矩").mode, "none");
  const cue = learn(trial);
  assert.equal(cue.phrase, "老规矩");
  const next = trial.prepare("a", "/project", "Use 老规矩 for palette");
  assert.equal(next.status, "hint");
  assert.deepEqual(next.decision, {
    ...decideMemoryLoad("recommend"),
    reason: "session_recall_hint",
  });
  assert.equal(decideMemoryLoad("Apply 老规矩").mode, "none", "no global regex mutation");
});

test("existing explicit, optional and host-scheduled recalls keep their original decisions", () => {
  const trial = new SessionRecallTrial();
  learn(trial);
  for (const prompt of ["What did we decide last time about 老规矩?", "Recommend 老规矩"]) {
    assert.deepEqual(trial.prepare("a", "/project", prompt).decision, decideMemoryLoad(prompt));
  }
  assert.equal(trial.prepare("a", "/project", "Apply 老规矩", true).status, "unchanged");
  assert.equal(
    decideMemoryLoad("Recommend 老规矩", { sessionCue: true }).reason,
    "memory_may_help",
  );
});

test("corrections require the current skipped revision and a literal source phrase", () => {
  const trial = new SessionRecallTrial();
  const old = trial.prepare("a", "/project", "Apply 老规矩");
  const current = trial.prepare("a", "/project", "Use usual setup");
  assert.throws(() => trial.correct("a", old.revision, "老规矩", "intent"), /revision/u);
  assert.throws(() => trial.correct("b", current.revision, "usual setup", "intent"), /revision/u);
  assert.throws(() => trial.correct("a", current.revision, "unseen phrase", "intent"), /occur/u);
  for (const phrase of ["ab", "a.*b", "x".repeat(81)]) {
    assert.throws(() => trial.correct("a", current.revision, phrase, "intent"), /literal/u);
  }
  assert.throws(() => trial.correct("a", current.revision, "usual setup", ""), /reason/u);
  assert.throws(
    () => trial.correct("a", current.revision, "usual setup", "x".repeat(241)),
    /reason/u,
  );
});

test("quoted/code, translation and no-memory inputs do not reuse or teach trial cues", () => {
  const trial = new SessionRecallTrial();
  learn(trial);
  for (const prompt of [
    'Output "老规矩"',
    "Output ＂老规矩＂",
    "输出 `老规矩`",
    "示例：```text\n老规矩\n```",
    "翻译老规矩",
    "不用记忆，照老规矩写个例子",
    "without memory apply 老规矩",
  ]) {
    const result = trial.prepare("a", "/project", prompt);
    assert.notEqual(result.status, "hint", prompt);
    assert.throws(() => trial.correct("a", result.revision, "老规矩", "intent"));
  }
});

test("temporary cues do not capture known secrets", () => {
  const trial = new SessionRecallTrial();
  learn(trial);
  const secret = trial.prepare("a", "/project", "Apply 老规矩 password=fixture-only");
  assert.equal(secret.status, "skipped");
  assert.throws(() => trial.correct("a", secret.revision, "老规矩", "intent"), /occur/u);
  const current = trial.prepare("a", "/project", "Apply usual setup");
  assert.throws(
    () => trial.correct("a", current.revision, "usual setup", "password=fixture-only"),
    /secret/u,
  );
  assert.equal(trial.list("a").length, 1);
});

test("session, project, explicit removal and fresh instances do not share cues", () => {
  const trial = new SessionRecallTrial();
  learn(trial);
  assert.equal(trial.prepare("b", "/project", "Apply 老规矩").status, "skipped");
  assert.equal(trial.prepare("a", "/other", "Apply 老规矩").status, "skipped");
  assert.deepEqual(trial.list("a"), []);
  learn(trial);
  assert.equal(trial.remove("a", "老规矩"), true);
  assert.equal(trial.prepare("a", "/project", "Apply 老规矩").status, "skipped");
  learn(trial);
  assert.equal(trial.clear("a"), true);
  assert.deepEqual(trial.list("a"), []);
  assert.equal(new SessionRecallTrial().prepare("a", "/project", "Apply 老规矩").status, "skipped");
});

test("Latin cues have word boundaries, case normalization and copied metadata", () => {
  const trial = new SessionRecallTrial();
  learn(trial, "Old Style");
  assert.equal(trial.prepare("a", "/project", "use OLD STYLE").status, "hint");
  for (const prompt of ["gold styles", "old stylesheet"]) {
    assert.equal(trial.prepare("a", "/project", prompt).status, "skipped");
  }
  const rows = trial.list("a");
  rows[0]!.phrase = "a mutated hint";
  assert.equal(trial.list("a")[0]!.phrase, "old style");
});

test("cache cardinality and captured queries are bounded", () => {
  const trial = new SessionRecallTrial();
  for (let index = 0; index < 9; index++) learn(trial, `special phrase ${index}`);
  assert.equal(trial.list("a").length, 8);
  assert.equal(
    trial.list("a").some((cue) => cue.phrase === "special phrase 0"),
    false,
  );
  for (let index = 0; index < 33; index++) learn(trial, "usual setup", `s${index}`);
  assert.deepEqual(trial.list("s0"), []);
  const long = trial.prepare("long", "/project", `usual setup ${"x".repeat(4096)}`);
  assert.throws(() => trial.correct("long", long.revision, "usual setup", "intent"), /occur/u);
  const expanded = trial.prepare("expanded", "/project", `usual setup ${"ﬃ".repeat(2048)}`);
  assert.throws(
    () => trial.correct("expanded", expanded.revision, "usual setup", "intent"),
    /occur/u,
  );
});
