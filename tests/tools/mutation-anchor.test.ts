/**
 * A derived mutant: the operator says what to do, the selector says where, and the bytes are computed
 * from the source rather than stored beside it.
 *
 * The rule this file pins is that a tooth's identity is not its text. A byte anchor dies the first time
 * the formatter, a rename or a lifted condition changes the bytes around the site - and it dies
 * silently, which is how two teeth stopped pointing at their rule without a build noticing. So the
 * selectors below are asserted twice: once on the source as written, and once on the same code after a
 * refactor that preserves it. Nothing here touches the filesystem.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { locate, matchText, type Mutant } from "../../tools/mutation-anchor.ts";

const SOURCE = `function selection(tasks, slots) {
  const spent = slots < 1;
  const ready = (task) => current(task) && !task.cancelled && !task.waiting;
  if (spent || severalWaits) return answer([], 0, "closed");
  const ids = (pending) =>
    tasks.filter((task) => !task.claimed && ready(task)).map((task) => task.id);
  causes.set(task.id, own.length > 0 ? own : []);
  return { outcome: "discard", sessionReusable: false };
}
`;

/** The bytes a mutant would replace: asserting the selection beats asserting offsets. */
function selected(source: string, mutant: Mutant): string {
  const site = locate(source, mutant);
  assert.ok(!("reason" in site), `expected a site, got ${"reason" in site ? site.reason : ""}`);
  return source.slice(site.start, site.end);
}

function refusal(source: string, mutant: Mutant): string {
  const site = locate(source, mutant);
  assert.ok(
    "reason" in site,
    `expected a refusal, got a site: ${source.slice(site.start, site.end)}`,
  );
  return site.reason;
}

const named = (name: string, derive: Mutant["derive"], extra: Partial<Mutant> = {}): Mutant => ({
  name,
  derive,
  expect: "unused here",
  ...extra,
});

test("a guard that never holds is the condition, and nothing around it", () => {
  const above = `function selection(task) {\n  if (!task.accepted) return false;\n  return true;\n}\n`;
  assert.equal(
    selected(
      above,
      named("x", { within: "selection", operator: "condition-never", condition: "!task.accepted" }),
    ),
    "!task.accepted",
  );
});

test("a rule written as a return is a condition too, and it can hold or never hold", () => {
  const above = `function selection(task) {\n  return !task.cancelled && !task.waiting;\n}\n`;
  const whole = "!task.cancelled && !task.waiting";
  for (const operator of ["condition-holds", "condition-never"] as const)
    assert.equal(
      selected(above, named("x", { within: "selection", operator, condition: whole })),
      whole,
    );
});

test("an operator that replaces a whole condition refuses a fragment that names only part of it", () => {
  const reason = refusal(
    SOURCE,
    named("x", { within: "selection", operator: "condition-holds", condition: "!task.cancelled" }),
  );
  assert.match(reason, /names part of selection's condition.*use neutralize-term for a term/);
});

test("a term's identity is the literal its operator absorbs: true under &&, false under ||", () => {
  const term = (condition: string, text: string): Mutant =>
    named("x", { within: "selection", operator: "neutralize-term", condition, term: text });
  assert.equal(
    selected(SOURCE, term("!task.cancelled && !task.waiting", "!task.waiting")),
    "!task.waiting",
  );
  assert.equal(selected(SOURCE, term("spent || severalWaits", "severalWaits")), "severalWaits");
});

test("a term's identity is read through the brackets that close it", () => {
  const above = `function selection(a, b) {\n  return a && (b || !b);\n}\n`;
  const site = locate(
    above,
    named("x", { within: "selection", operator: "neutralize-term", condition: "b", term: "!b" }),
  );
  assert.ok(!("reason" in site));
  assert.equal(above.slice(site.start, site.end), "!b");
});

test("a term the code does not join with a logical operator is refused, not guessed", () => {
  const above = `function selection(a, b) {\n  if (a === b) return false;\n  return true;\n}\n`;
  const reason = refusal(
    above,
    named("x", {
      within: "selection",
      operator: "neutralize-term",
      condition: "a === b",
      term: "a",
    }),
  );
  assert.match(reason, /cannot tell which operator joins the term/);
});

test("an argument is selected by the call it belongs to and its position", () => {
  const site = selected(
    SOURCE,
    named(
      "x",
      { within: "selection", operator: "replace-argument", call: "causes.set", arg: 1 },
      { to: "[]" },
    ),
  );
  assert.equal(site, "own.length > 0 ? own : []");
});

test("a call that appears twice in the member is refused, and so is an argument that is not there", () => {
  const twice = `function selection(a) {\n  causes.set(a.id, 1);\n  causes.set(a.other, 2);\n}\n`;
  assert.match(
    refusal(
      twice,
      named(
        "x",
        { within: "selection", operator: "replace-argument", call: "causes.set", arg: 1 },
        { to: "[]" },
      ),
    ),
    /matched 2 sites/,
  );
  assert.match(
    refusal(
      SOURCE,
      named(
        "x",
        { within: "selection", operator: "replace-argument", call: "causes.set", arg: 3 },
        { to: "[]" },
      ),
    ),
    /has no argument 3/,
  );
});

test("a property is selected by name, and by the literal that holds it when the name repeats", () => {
  const property: Mutant["derive"] = {
    within: "selection",
    operator: "replace-property",
    property: "sessionReusable",
  };
  assert.equal(selected(SOURCE, named("x", property, { to: "true" })), "false");
  const twice = `function selection() {\n  if (a) return { outcome: "wait", sessionReusable: true };\n  return { outcome: "discard", sessionReusable: false };\n}\n`;
  assert.match(refusal(twice, named("x", property, { to: "true" })), /matched 2 sites/);
  assert.equal(
    selected(twice, named("x", { ...property, in: 'outcome: "discard"' }, { to: "true" })),
    "false",
  );
});

test("a dropped statement takes its line and its indentation, and refuses to guess otherwise", () => {
  const above = `function selection(task) {\n  causes.push("stale-input");\n  return task;\n}\n`;
  // The indentation and the newline go with it: what is left is a hole where the line was.
  assert.equal(
    selected(
      above,
      named("x", { within: "selection", operator: "drop-statement", statement: "causes.push" }),
    ),
    '  causes.push("stale-input");\n',
  );
  const shared = `function selection(task) {\n  if (task.accepted) return task;\n  return null;\n}\n`;
  assert.match(
    refusal(
      shared,
      named("x", { within: "selection", operator: "drop-statement", statement: "return task;" }),
    ),
    /does not begin its line/,
  );
});

test("the fragment is matched inside the selected condition, not anywhere in the member", () => {
  const above = `function selection(task) {\n  causes.push("stale-input");\n  if (!task.accepted) return false;\n  return true;\n}\n`;
  assert.match(
    refusal(
      above,
      named("x", { within: "selection", operator: "condition-never", condition: '"stale-input"' }),
    ),
    /0 conditions in selection mention/,
  );
});

test("a member the selector cannot tell apart is refused: none, several, or a fragment that fits two", () => {
  const absent = refusal(
    SOURCE,
    named("x", { within: "elsewhere", operator: "condition-never", condition: "spent" }),
  );
  assert.match(absent, /member elsewhere matched 0 members/);
  const twice = `function selection(a) {\n  if (!a) return 1;\n}\nfunction selection(b) {\n  if (!b) return 2;\n}\n`;
  assert.match(
    refusal(
      twice,
      named("x", { within: "selection", operator: "condition-never", condition: "!b" }),
    ),
    /member selection matched 2 members/,
  );
  assert.match(
    refusal(
      SOURCE,
      named("x", { within: "selection", operator: "condition-never", condition: "task" }),
    ),
    /conditions in selection mention task/,
  );
});

test("when a fragment sits inside two decision positions, the innermost one is the site", () => {
  const nested = named("x", {
    within: "selection",
    operator: "condition-holds",
    condition: "!task.claimed && ready(task)",
  });
  assert.equal(selected(SOURCE, nested), "!task.claimed && ready(task)");
});

test("the same tooth applies after the code around it is refactored", () => {
  const renamed = SOURCE.replaceAll("ready(task)", "isReady(task)");
  const lifted = SOURCE.replace(
    "  if (spent || severalWaits) return answer",
    "  const closed = spent || severalWaits;\n  if (closed) return answer",
  );
  const tooth = named("x", {
    within: "selection",
    operator: "neutralize-term",
    condition: "spent || severalWaits",
    term: "spent",
  });
  for (const source of [SOURCE, renamed, lifted]) assert.equal(selected(source, tooth), "spent");
  // The byte anchors the same sites used to carry do not survive either edit - which is the point.
  const renamedAnchor: Mutant = {
    name: "old",
    from: "    tasks.filter((task) => !task.claimed && ready(task)).map((task) => task.id);",
    to: "    tasks.filter((task) => !task.claimed).map((task) => task.id);",
    expect: "x",
  };
  const liftedAnchor: Mutant = {
    name: "old",
    from: '  if (spent || severalWaits) return answer([], 0, "closed");',
    to: '  if (severalWaits) return answer([], 0, "closed");',
    expect: "x",
  };
  assert.ok("reason" in locate(renamed, renamedAnchor));
  assert.ok("reason" in locate(lifted, liftedAnchor));
});

test("a mutant with no derive operator and no bytes is refused, and so is one with bytes but no replacement", () => {
  assert.match(
    refusal(SOURCE, { name: "x", expect: "x" }),
    /mutant has no replacement and no derive operator/,
  );
  assert.match(
    refusal(SOURCE, { name: "x", from: "  return {", expect: "x" }),
    /mutant has no replacement/,
  );
});

test("matchText still refuses a marker that occurs twice, and re-takes a reflowed one", () => {
  assert.deepEqual(matchText("a && b", "a && b"), { start: 0, end: 6, retaken: false });
  assert.ok("reason" in matchText("x x", "x"));
  const reflowed = matchText("a  &&\n  b", "a && b");
  assert.ok(!("reason" in reflowed) && reflowed.retaken);
});
