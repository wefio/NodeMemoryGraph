import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkRtm } from "../../tools/rtm-check.ts";

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function contractYaml(assertions: string): string {
  return [
    "apiVersion: repository.nmg.dev/v1alpha1",
    "kind: AgentChange",
    "metadata:",
    "  id: fixture-change",
    "spec:",
    "  intent: Fixture change",
    "  scope:",
    "    include: [src/**]",
    "  preserve: []",
    "  assertions:",
    assertions,
    "  verification:",
    "    routes: [source]",
    "    checks: [check, unused:check]",
    "    forgeChecks: []",
    "  authority:",
    "    mode: plan",
    "",
  ].join("\n");
}

function fixture(assertions: string): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-rtm-"));
  write(
    root,
    "package.json",
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { check: "true" } }),
  );
  write(
    root,
    "agent-context.yaml",
    [
      "version: 1",
      "routes:",
      "  - id: source",
      "    paths: [src/**]",
      "    owners: []",
      "    tests: [tests/**]",
      "    verify:",
      "      blocking: [check]",
      "      advisory: []",
      "",
    ].join("\n"),
  );
  write(root, ".rcp/contracts/fixture.yaml", contractYaml(assertions));
  write(root, "tests/sample.test.ts", 'test("covers one", () => {});\n');
  return root;
}

function withFixture(t: test.TestContext, assertions: string, run: (root: string) => void): void {
  const root = fixture(assertions);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root);
}

const TRACEABLE = [
  "    - id: one",
  "      statement: One claim",
  '      check: "node-test:source#covers one"',
  "      kind: test",
  "      stage: unit",
  "    - id: two",
  "      statement: Two claim",
  "      check: node-test:source",
  "      kind: test",
  "      stage: integration",
  "    - id: three",
  "      statement: Three claim",
  "      documentedOnly: true",
  "",
].join("\n");

test("a named test resolves to per-claim evidence, and a missing name fails closed", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    assert.deepEqual(checkRtm(root).uncovered, []);
  });
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      '      check: "node-test:source#no such test"',
      "      kind: test",
      "      stage: unit",
      "",
    ].join("\n"),
    (root) => {
      const report = checkRtm(root);
      assert.equal(report.uncovered.length, 1);
      assert.match(report.uncovered[0], /no such test/u);
    },
  );
});

test("the repository contracts are fully traceable", () => {
  const report = checkRtm();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.uncovered, []);
  assert.ok(report.contracts >= 2, `expected the authored contracts, got ${report.contracts}`);
  assert.ok(report.assertions >= 10, `expected the migrated assertions, got ${report.assertions}`);
  assert.ok(report.documentedOnly >= 1, "a documented-only gap must stay visible");
});

test("every assertion resolves to a check, a route test, or documented-only", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    const report = checkRtm(root);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.uncovered, []);
    assert.equal(report.assertions, 3);
    assert.equal(report.verified, 2);
    assert.equal(report.documentedOnly, 1);
  });
});

test("an assertion whose check does not resolve fails closed", (t) => {
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      check: no:such:check",
      "      kind: test",
      "      stage: unit",
      "",
    ].join("\n"),
    (root) => {
      const report = checkRtm(root);
      assert.equal(report.uncovered.length, 1);
      assert.match(report.uncovered[0], /one -> no:such:check/u);
      assert.equal(report.verified, 0);
    },
  );
});

test("an assertion with neither a check nor documented-only fails closed", (t) => {
  withFixture(
    t,
    ["    - id: one", "      statement: One claim", "      kind: test", ""].join("\n"),
    (root) => {
      const report = checkRtm(root);
      assert.match(report.errors.join("\n"), /needs a check or documentedOnly/u);
    },
  );
});

test("duplicate assertion ids and unknown fields fail closed", (t) => {
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      check: check",
      "    - id: one",
      "      statement: Duplicate id",
      "      check: check",
      "",
    ].join("\n"),
    (root) => {
      assert.match(checkRtm(root).errors.join("\n"), /is duplicated/u);
    },
  );
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      check: check",
      "      note: nope",
      "",
    ].join("\n"),
    (root) => {
      assert.match(checkRtm(root).errors.join("\n"), /note is not supported/u);
    },
  );
});

test("an unknown kind or stage fails closed", (t) => {
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      check: check",
      "      kind: vibe",
      "      stage: unit",
      "",
    ].join("\n"),
    (root) => {
      assert.match(checkRtm(root).errors.join("\n"), /kind must be one of/u);
    },
  );
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      check: check",
      "      stage: deployment",
      "",
    ].join("\n"),
    (root) => {
      assert.match(checkRtm(root).errors.join("\n"), /stage must be one of/u);
    },
  );
});

test("a declared check no assertion claims is reported as an orphan, not a failure", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    const report = checkRtm(root);
    assert.deepEqual(report.orphans, ["check", "unused:check"]);
    assert.deepEqual(report.errors, []);
  });
});
