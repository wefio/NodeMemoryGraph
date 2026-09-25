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

test("a class constructor is a member, and its name is `constructor`", () => {
  const classSource = `class Gate {\n  constructor(runs, wanted) {\n    const recorded = runs.find((run) => run.id === wanted.id);\n    if (recorded && recorded.policy !== wanted.policy) refuse("policy changed");\n  }\n}\n`;
  const inConstructor = named("x", {
    within: "constructor",
    operator: "condition-never",
    condition: "recorded && recorded.policy !== wanted.policy",
  });
  assert.equal(
    selected(classSource, inConstructor),
    "recorded && recorded.policy !== wanted.policy",
  );
  assert.match(
    refusal(
      classSource,
      named("x", { within: "Gate", operator: "condition-never", condition: "recorded" }),
    ),
    /member Gate matched 0 members/,
  );
});

test("a condition written across lines is one condition, and a reflowed fragment still names it", () => {
  const wrapped = `function refuseSuggestion(suggestion, projection) {\n  const provenance = suggestion.provenance;\n  if (\n    provenance.sessionId !== projection.sessionId ||\n    provenance.branchId !== projection.branchId\n  ) {\n    return "other scope";\n  }\n  return null;\n}\n`;
  const scope = named("x", {
    within: "refuseSuggestion",
    operator: "condition-never",
    condition:
      "provenance.sessionId !== projection.sessionId || provenance.branchId !== projection.branchId",
  });
  assert.match(
    selected(wrapped, scope),
    /^provenance\.sessionId !== projection\.sessionId \|\|\n\s+provenance\.branchId !== projection\.branchId$/u,
  );
});

test("a guard clause is a statement that can be dropped, listed among the statements that can", () => {
  const guarded = `function claim(id, agentId, cancelled) {\n  if (!id || !agentId) throw new Error("task and agent required");\n  if (cancelled !== null) throw new Error("round cancelled");\n  return id;\n}\n`;
  const guard = named("x", {
    within: "claim",
    operator: "drop-statement",
    statement: 'if (cancelled !== null) throw new Error("round cancelled");',
  });
  assert.equal(
    selected(guarded, guard),
    '  if (cancelled !== null) throw new Error("round cancelled");\n',
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

test("a negated condition is the negation, and the `!` on a whole condition is the one that goes", () => {
  const above = `function selection(binding, cancelled) {\n  if (!binding) return apply();\n  if (binding && cancelled) return null;\n  return binding;\n}\n`;
  assert.equal(
    selected(
      above,
      named("x", {
        within: "selection",
        operator: "negate-condition",
        condition: "!binding",
      }),
    ),
    "!",
  );
  assert.equal(
    selected(
      above,
      named("x", {
        within: "selection",
        operator: "negate-condition",
        condition: "binding && cancelled",
      }),
    ),
    "binding && cancelled",
  );
});

test("the negated condition is wrapped, not unwrapped, when the `!` binds one operand only", () => {
  const above = `function selection(a, b) {\n  if (!a || b) return 1;\n  return 0;\n}\n`;
  const site = locate(
    above,
    named("x", { within: "selection", operator: "negate-condition", condition: "!a || b" }),
  );
  assert.ok(!("reason" in site));
  assert.equal(above.slice(site.start, site.end), "!a || b");
  // The replacement is the whole condition wrapped: dropping the `!` would negate `a` alone.
  assert.equal(site.replacement, "!(!a || b)");
});

test("a comparison is negated in place, keeping both sides and the spacing around them", () => {
  const above = `function selection(verdict) {\n  if (verdict !== "accepted") return false;\n  return true;\n}\n`;
  const site = locate(
    above,
    named("x", {
      within: "selection",
      operator: "negate-comparison",
      condition: 'verdict !== "accepted"',
    }),
  );
  assert.ok(!("reason" in site));
  assert.equal(above.slice(site.start, site.end), "!==");
  assert.equal(site.replacement, "===");
  assert.match(
    refusal(
      above,
      named("x", {
        within: "selection",
        operator: "negate-comparison",
        condition: 'verdict === "absent"',
      }),
    ),
    /0 comparisons in selection match the selector/,
  );
});

test("a dropped guard keeps its body, and refuses an else or a block body rather than rewriting it", () => {
  const above = `function selection(spec, path, content, files) {\n  if (spec.baseline[path] !== content) files[path] = content;\n  return files;\n}\n`;
  assert.equal(
    selected(
      above,
      named("x", {
        within: "selection",
        operator: "remove-conditionals",
        condition: "spec.baseline[path] !== content",
      }),
    ),
    "if (spec.baseline[path] !== content) files[path] = content;",
  );
  const withElse = `function selection(a, b) {\n  if (a) b();\n  else c();\n  return a;\n}\n`;
  assert.match(
    refusal(
      withElse,
      named("x", { within: "selection", operator: "remove-conditionals", condition: "a" }),
    ),
    /has an else/,
  );
  const withBlock = `function selection(a, b) {\n  if (a) {\n    b();\n  }\n  return a;\n}\n`;
  assert.match(
    refusal(
      withBlock,
      named("x", { within: "selection", operator: "remove-conditionals", condition: "a" }),
    ),
    /body in selection is a block/,
  );
});

test("removing a call leaves its receiver, and a call that is not a method is refused", () => {
  const above = `function selection(board, attempted, values) {\n  const legal = board.candidates().filter((id) => !attempted.has(id));\n  const plain = Number(values);\n  return [legal, plain];\n}\n`;
  assert.equal(
    selected(
      above,
      named("x", {
        within: "selection",
        operator: "remove-call",
        call: "board.candidates().filter",
      }),
    ),
    "board.candidates().filter((id) => !attempted.has(id))",
  );
  assert.match(
    refusal(above, named("x", { within: "selection", operator: "remove-call", call: "Number" })),
    /needs a method call/,
  );
});

test("a call is replaced by the declared source of the same shape", () => {
  const above = `function selection(board, input) {\n  const legal = board.candidates().filter(Boolean);\n  return legal;\n}\n`;
  const site = locate(
    above,
    named(
      "x",
      { within: "selection", operator: "replace-call", call: "board.candidates" },
      { to: "input.plan" },
    ),
  );
  assert.ok(!("reason" in site));
  assert.equal(above.slice(site.start, site.end), "board.candidates()");
  assert.equal(site.replacement, "input.plan");
});

test("two calls to the same callee are told apart by the statement each sits in", () => {
  const above = `function selection(board, attempted) {
  const onOffer = board.candidates();
  const legal = board.candidates().filter((id) => !attempted.has(id));
  return [onOffer, legal];
}
`;
  assert.match(
    refusal(
      above,
      named(
        "x",
        { within: "selection", operator: "replace-call", call: "board.candidates" },
        { to: "input.plan" },
      ),
    ),
    /2 calls to board.candidates in selection match the selector/,
  );
  const site = locate(
    above,
    named(
      "x",
      {
        within: "selection",
        operator: "replace-call",
        call: "board.candidates",
        in: "board.candidates().filter",
      },
      { to: "input.plan" },
    ),
  );
  assert.ok(!("reason" in site));
  assert.equal(above.slice(site.start, site.end), "board.candidates()");
});

test("a variable's value is replaced by the declared one, and an absent one is refused", () => {
  const above = `function selection(shape) {\n  const sessions = Math.ceil(shape.units / per);\n  return sessions;\n}\n`;
  const site = locate(
    above,
    named(
      "x",
      { within: "selection", operator: "replace-initializer", variable: "sessions" },
      { to: "shape.units" },
    ),
  );
  assert.ok(!("reason" in site));
  assert.equal(above.slice(site.start, site.end), "Math.ceil(shape.units / per)");
  const absent = `function selection(shape) {\n  const sessions = shape.units;\n  return sessions;\n}\n`;
  assert.match(
    refusal(
      absent,
      named(
        "x",
        { within: "selection", operator: "replace-initializer", variable: "count" },
        { to: "0" },
      ),
    ),
    /0 declarations of count/,
  );
});

test("a loop's iterable is replaced by the declared one, and the loop is named when there are several", () => {
  const above = `function selection(budgets, other) {\n  const seen = [];\n  for (const budget of budgets) {\n    seen.push(budget);\n  }\n  for (const item of other) {\n    seen.push(item);\n  }\n  return seen;\n}\n`;
  assert.equal(
    selected(
      above,
      named(
        "x",
        { within: "selection", operator: "replace-iterable", iterable: "of budgets" },
        { to: "[]" },
      ),
    ),
    "budgets",
  );
  assert.match(
    refusal(
      above,
      named(
        "x",
        { within: "selection", operator: "replace-iterable", iterable: "of" },
        { to: "[]" },
      ),
    ),
    /2 loops in selection match the selector/,
  );
});

test("a call is told from another by a fragment of its own text", () => {
  const above = `function selection() {\n  const a = clockNow("later") + clockNow("earlier");\n  return a;\n}\n`;
  assert.equal(
    selected(
      above,
      named(
        "x",
        {
          within: "selection",
          operator: "replace-argument",
          call: "clockNow",
          arg: 0,
          in: '"later"',
        },
        { to: '"earlier"' },
      ),
    ),
    '"later"',
  );
  assert.match(
    refusal(
      above,
      named(
        "x",
        { within: "selection", operator: "replace-argument", call: "clockNow", arg: 0 },
        { to: '"earlier"' },
      ),
    ),
    /matched 2 sites/,
  );
});

test("a function bound to a name is a member, and the selectors search its body", () => {
  const above = `const selection = (values) => {\n  const spec = new RegExp("x").exec(values);\n  return spec;\n};\n`;
  const site = locate(
    above,
    named(
      "x",
      { within: "selection", operator: "replace-initializer", variable: "spec" },
      { to: "null" },
    ),
  );
  assert.ok(!("reason" in site));
  assert.equal(above.slice(site.start, site.end), 'new RegExp("x").exec(values)');
});
