import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  collectPolicyWords,
  comparePolicyWords,
  inspectMechanism,
  policyWordsIn,
} from "../../tools/policy-word-check.ts";
import { POLICY_WORDS, type ClassifiedSite } from "../../tools/policy-word-list.ts";

function site(overrides: Partial<ClassifiedSite> = {}): ClassifiedSite {
  return {
    path: "src/core/store/example.ts",
    scope: "record",
    word: "patch",
    count: 1,
    classification: "policy",
    reason: "Existing shape assumption, not a mechanism.",
    ...overrides,
  };
}

test("camel, snake and kebab spellings are visible without counting dispatch as patch", () => {
  assert.deepEqual(
    policyWordsIn("patch_files preparePatchWork FrozenPatchWork PATCH_FILES", POLICY_WORDS),
    ["patch", "patch", "patch", "patch", "files", "files"],
  );
  assert.deepEqual(policyWordsIn("dispatch DispatchBoard dispatched", POLICY_WORDS), []);
  assert.deepEqual(policyWordsIn("repair-first repair_first repairFirst", POLICY_WORDS), [
    "repair-first",
    "repair-first",
    "repair-first",
  ]);
});

test("types, member accesses, SQL templates and runtime strings count; comments do not", () => {
  const hits = collectPolicyWords(
    "unit.ts",
    `// patch files instruction
    interface Ticket { patch?: FrozenPatchWork }
    function record() { const sql = \`patch_files TEXT, patch_editable TEXT\`;
      return parent.patch.editable + "not a patch task"; }
  `,
  );
  assert.equal(hits.filter((hit) => hit.word === "patch").length, 6);
  assert.ok(hits.some((hit) => hit.scope === "Ticket" && hit.word === "patch"));
  assert.ok(hits.some((hit) => hit.scope === "record" && hit.word === "editable"));
  assert.ok(hits.every((hit) => hit.line > 1));
});

test("a new policy word site is refused with its path and position", () => {
  const hits = collectPolicyWords(
    "src/core/store/example.ts",
    "function record() { return ticket.patch; }",
  );
  assert.match(
    comparePolicyWords(hits, [])[0]!,
    /example\.ts#record:patch: unclassified.*lines 1/u,
  );
  assert.deepEqual(comparePolicyWords(hits, [site()]), []);
  const doubled = collectPolicyWords(
    "src/core/store/example.ts",
    "function record() { return ticket.patch || parent.patch; }",
  );
  assert.match(comparePolicyWords(doubled, [site()])[0]!, /classified 1, found 2/u);
});

test("removing a leak requires retiring the classification rather than leaving dead exemptions", () => {
  assert.match(comparePolicyWords([], [site()])[0]!, /classified 1, found 0/u);
});

test("a same-count move to another member is not silently grandfathered", () => {
  const hits = collectPolicyWords(
    "src/core/store/example.ts",
    "function another() { return ticket.patch; }",
  );
  assert.equal(comparePolicyWords(hits, [site()]).length, 2);
});

test("class methods get distinct scope identities; whitespace and comment changes do not break them", () => {
  const collect = (text: string) =>
    collectPolicyWords("unit.ts", text).map(({ path, scope, word }) => ({ path, scope, word }));
  assert.deepEqual(
    collect("class Board { freeze() { return task.patch; } }"),
    collect("class Board {\n // patch\n freeze() { return task.patch; }\n }"),
  );
  assert.equal(
    collect("class Board { freeze() { return task.patch; } }")[0]!.scope,
    "Board.freeze",
  );
});

test("malformed TypeScript, invalid classifications and duplicate entries fail closed", () => {
  assert.throws(() => collectPolicyWords("broken.ts", "function broken( {"), /cannot inspect/u);
  assert.match(comparePolicyWords([], [site({ reason: "" })])[0]!, /invalid classification/u);
  assert.ok(
    comparePolicyWords([], [site(), site()]).some((error) =>
      /duplicate classification/u.test(error),
    ),
  );
});

test("the repository's maintained table classifies every occurrence on the declared surface", () => {
  const report = inspectMechanism(resolve(import.meta.dirname, "../.."));
  assert.ok(report.files > 0);
  assert.ok(report.hits.length > 0);
  assert.deepEqual(report.errors, []);
});
