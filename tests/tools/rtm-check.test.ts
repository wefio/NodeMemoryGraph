import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  write(
    root,
    "docs/design/assumptions.yaml",
    [
      "assumptions:",
      "  - id: fixture-assumption",
      "    statement: Fixture assumption",
      "    owner: source",
      "    falsifiedBy: rerun the fixture",
      "",
    ].join("\n"),
  );
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
  "      domain: every fixture case",
  "      assumes: [fixture-assumption]",
  '      check: "node-test:source#covers one"',
  "      kind: test",
  "      stage: unit",
  "    - id: two",
  "      statement: Two claim",
  "      domain: every fixture case",
  "      assumes: []",
  "      check: node-test:source",
  "      kind: test",
  "      stage: integration",
  "    - id: three",
  "      statement: Three claim",
  "      domain: every fixture case",
  "      assumes: []",
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
      "      domain: every fixture case",
      "      assumes: []",
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
    assert.equal(report.bound, 2);
    assert.equal(report.decision, 0);
    assert.equal(report.witness, 2);
    assert.equal(report.documentedOnly, 1);
    assert.equal(report.assumptions, 1);
  });
});

test("an assertion whose check does not resolve fails closed", (t) => {
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      domain: every fixture case",
      "      assumes: []",
      "      check: no:such:check",
      "      kind: test",
      "      stage: unit",
      "",
    ].join("\n"),
    (root) => {
      const report = checkRtm(root);
      assert.equal(report.uncovered.length, 1);
      assert.match(report.uncovered[0], /one -> no:such:check/u);
      assert.equal(report.bound, 0);
    },
  );
});

test("an assertion with neither a check nor documented-only fails closed", (t) => {
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      domain: every fixture case",
      "      assumes: []",
      "      kind: test",
      "",
    ].join("\n"),
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
      "      domain: every fixture case",
      "      assumes: []",
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
      "      domain: every fixture case",
      "      assumes: []",
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
      "      domain: every fixture case",
      "      assumes: []",
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
      "      domain: every fixture case",
      "      assumes: []",
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

test("an assertion without a domain fails closed", (t) => {
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      assumes: []",
      "      check: check",
      "",
    ].join("\n"),
    (root) => {
      assert.match(checkRtm(root).errors.join("\n"), /\.domain is required/u);
    },
  );
});

test("an assumption that resolves nowhere fails closed", (t) => {
  withFixture(
    t,
    [
      "    - id: one",
      "      statement: One claim",
      "      domain: every fixture case",
      "      assumes: [not-registered]",
      "      check: check",
      "",
    ].join("\n"),
    (root) => {
      assert.match(checkRtm(root).errors.join("\n"), /'not-registered' is assumed/u);
    },
  );
});

test("a route-level check fails closed when the route resolves to no file", (t) => {
  const assertions = [
    "    - id: one",
    "      statement: One claim",
    "      domain: every fixture case",
    "      assumes: []",
    "      check: node-test:source",
    "",
  ].join("\n");
  const root = fixture(assertions);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(checkRtm(root).uncovered, []);
  rmSync(join(root, "tests", "sample.test.ts"));
  assert.equal(checkRtm(root).uncovered.length, 1);
});

const EVIDENCE_PATH = ".nmg/verification/latest.json";

/** What `agent:verify` leaves behind: the commands it ran, and the revision it ran them over. */
function writeEvidence(
  root: string,
  head: string,
  results: readonly { command: string; status: string; reason?: string }[],
): void {
  write(
    root,
    EVIDENCE_PATH,
    JSON.stringify({
      finishedAt: "2026-09-20T00:00:00.000Z",
      report: { git: { head, dirtyFiles: [] } },
      result: { ok: results.every((entry) => entry.status === "passed"), results },
    }),
  );
}

function commitFixture(root: string): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]);
  git(["-c", "user.email=rtm@example.com", "-c", "user.name=rtm", "add", "-A"]);
  git(["-c", "user.email=rtm@example.com", "-c", "user.name=rtm", "commit", "-qm", "fixture"]);
  return git(["rev-parse", "HEAD"]).trim();
}

const boundStandings = (report: ReturnType<typeof checkRtm>) =>
  report.items.filter((item) => item.check).map((item) => item.standing);

test("binding a check is inventory, and the standing comes from recorded execution", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    const bare = checkRtm(root);
    assert.equal(bare.execution, undefined, "a fresh clone has no run recorded");
    assert.equal(bare.bound, 2, "bound stays a count, and is never read as a verdict");
    assert.deepEqual(boundStandings(bare), ["not-recorded", "not-recorded"]);
    assert.deepEqual(
      bare.items.map((item) => item.standing),
      ["not-recorded", "not-recorded", "documented-only"],
    );
    assert.ok(
      bare.counterexamples.includes("no execution evidence: fixture-change:one"),
      `counterexamples: ${JSON.stringify(bare.counterexamples)}`,
    );
    assert.deepEqual(bare.errors, []);
  });
});

test("current evidence at the same revision is what makes an assertion executed", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    const head = commitFixture(root);
    writeEvidence(root, head, [{ command: "check", status: "passed" }]);
    const report = checkRtm(root);
    assert.equal(report.execution?.current, true);
    assert.deepEqual(boundStandings(report), ["executed", "executed"]);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      report.riskClasses.map((group) => group.riskClass),
      ["witness/test/integration", "witness/test/unit", "witness/unspecified/unspecified"],
      "each risk class is listed on its own, with no class summed into another",
    );
  });
});

test("evidence from another revision is historical, not execution", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    commitFixture(root);
    writeEvidence(root, "0".repeat(40), [{ command: "check", status: "passed" }]);
    const report = checkRtm(root);
    assert.equal(report.execution?.current, false);
    assert.deepEqual(boundStandings(report), ["historical", "historical"]);
    assert.deepEqual(report.errors, [], "a stale reading is a gap in the evidence, not a failure");
  });
});

test("a command that did not run is reported with its reason, and only a failure fails closed", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    const head = commitFixture(root);
    writeEvidence(root, head, [{ command: "check", status: "skipped", reason: "dry run" }]);
    const skipped = checkRtm(root);
    assert.deepEqual(boundStandings(skipped), ["not-run", "not-run"]);
    assert.match(skipped.items[0]?.evidence.join(" ") ?? "", /check=skipped \(dry run\)/u);
    assert.deepEqual(
      skipped.errors,
      [],
      "a run that skipped the command is a gap in the evidence, not a failed assertion",
    );
    writeEvidence(root, head, [{ command: "check", status: "failed" }]);
    const failed = checkRtm(root);
    assert.deepEqual(boundStandings(failed), ["not-run", "not-run"]);
    assert.match(failed.errors.join("\n"), /check failed in the current run/u);
  });
});

test("a contract whose scope spans several routes is judged on its own", (t) => {
  withFixture(t, TRACEABLE, (root) => {
    write(
      root,
      ".rcp/contracts/fixture.yaml",
      contractYaml(TRACEABLE).replace(
        "    include: [src/**]",
        "    include: [src/**, docs/design/**]",
      ),
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
        "  - id: documentation",
        "    paths: [docs/**]",
        "    owners: []",
        "    tests: [tests/**]",
        "    verify:",
        "      blocking: [docs:check]",
        "      advisory: []",
        "",
      ].join("\n"),
    );
    const head = commitFixture(root);
    writeEvidence(root, head, [
      { command: "check", status: "passed" },
      { command: "docs:check", status: "passed" },
    ]);
    const report = checkRtm(root);
    assert.equal(report.crossModule.length, 1);
    assert.deepEqual(report.crossModule[0]?.routes, ["documentation", "source"]);
    assert.deepEqual(boundStandings(report), ["executed", "executed"]);
  });
});
