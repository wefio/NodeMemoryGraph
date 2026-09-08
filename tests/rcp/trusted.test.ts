import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installTrusted, testOutputPassed, verifyTrusted } from "../../src/rcp/trusted.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nmg-trust-contract-"));
  const repo = join(root, "candidate");
  mkdirSync(repo);
  const put = (path: string, value: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), value);
  };
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=RCP", "-c", "user.email=rcp@example.invalid", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  put("package.json", '{"type":"module"}');
  put("src/value.ts", "export const value = 1;\n");
  for (const name of ["trusted.ts", "canonical.ts"])
    put(
      `src/rcp/${name}`,
      readFileSync(fileURLToPath(new URL(`../../src/rcp/${name}`, import.meta.url)), "utf8"),
    );
  put(
    "tests/value.test.ts",
    "import assert from 'node:assert/strict'; import test from 'node:test'; import { value } from '../src/value.ts'; test('baseline value obligation', () => assert.equal(value, 1));\n",
  );
  const policy = {
    schema: "repository.trusted-policy/v1",
    candidateRoots: ["src"],
    obligations: [
      {
        id: "value-one",
        claim: "exported value is one",
        tests: ["tests/value.test.ts"],
        timeoutMs: 10000,
      },
    ],
  };
  put(".rcp/trusted-policy.json", JSON.stringify(policy));
  git("init", "-q");
  const baseline = commit();
  const installation = join(root, "trusted");
  installTrusted(repo, baseline, installation);
  return {
    root,
    repo,
    put,
    commit,
    baseline,
    installation,
    policy,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

test("trusted CLI freezes commits and baseline tests import candidate product, not baseline product", () => {
  const f = fixture();
  try {
    const good = verifyTrusted(f.installation, f.repo, f.baseline);
    assert.equal(good.decision, "passed", JSON.stringify(good));
    const cliInstall = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(f.installation, "src/rcp/trusted.ts"),
        "install",
        f.repo,
        f.baseline,
        join(f.root, "cli-installed"),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(cliInstall.status, 0, cliInstall.stderr);
    assert.equal(JSON.parse(cliInstall.stdout).sourceDigest, good.baseline.digest);
    f.put("src/value.ts", "export const value = 2;\n");
    // Dirty work is not silently committed or included in a named commit.
    assert.equal(
      verifyTrusted(f.installation, f.repo, f.baseline).candidate.digest,
      good.candidate.digest,
    );
    const badCommit = f.commit();
    const cli = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(f.installation, "src/rcp/trusted.ts"),
        "verify",
        f.repo,
        badCommit,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(cli.status, 1, cli.stderr);
    const bad = JSON.parse(cli.stdout);
    assert.equal(bad.decision, "failed");
    assert.notEqual(
      bad.candidate.digest,
      good.candidate.digest,
      "stale evidence has a different source binding",
    );
    assert.notEqual(bad.invocationId, good.invocationId, "evidence is never reused");
    assert.equal(bad.baseline.digest, good.baseline.digest);
    f.put("tests/value.test.ts", "import test from 'node:test'; test('weakened', () => {});\n");
    const weakened = verifyTrusted(f.installation, f.repo, f.commit());
    assert.equal(weakened.decision, "blocked");
    assert.ok(weakened.diagnostics.some((message) => message.includes("tests/value.test.ts")));
  } finally {
    f.cleanup();
  }
});

test("candidate verifier cannot replace installed verifier; rules cannot lose obligations", () => {
  const f = fixture();
  try {
    f.put(
      "src/rcp/trusted.ts",
      "throw new Error('candidate verifier must not execute as authority');\n",
    );
    assert.equal(verifyTrusted(f.installation, f.repo, f.commit()).decision, "passed");
    f.put(".rcp/trusted-policy.json", JSON.stringify({ ...f.policy, obligations: [] }));
    assert.equal(verifyTrusted(f.installation, f.repo, f.commit()).decision, "blocked");
    assert.throws(() => installTrusted(f.repo, "HEAD", join(f.root, "invalid")), /obligations/);
    assert.throws(() => installTrusted(f.repo, f.baseline, f.installation), /must not exist/);
    assert.throws(() => installTrusted(f.repo, f.baseline, join(f.repo, "inside")), /outside/);
    f.put(
      ".rcp/trusted-policy.json",
      JSON.stringify({
        ...f.policy,
        obligations: [{ ...f.policy.obligations[0], tests: ["tests/missing.test.ts"] }],
      }),
    );
    f.commit();
    assert.throws(
      () => installTrusted(f.repo, "HEAD", join(f.root, "missing-test")),
      /missing baseline acceptance test/,
    );
    f.put(".rcp/trusted-policy.json", JSON.stringify(f.policy));
    f.put(
      "package.json",
      '{"type":"module","scripts":{"check":"exit 0"},"dependencies":{"missing-package":"1.0.0"}}',
    );
    const dependencyCommit = f.commit();
    assert.equal(verifyTrusted(f.installation, f.repo, dependencyCommit).decision, "blocked");
    assert.throws(
      () => installTrusted(f.repo, dependencyCommit, join(f.root, "no-lock")),
      /requires package-lock/,
    );
    writeFileSync(join(f.installation, "tests/value.test.ts"), "// weakened installed test\n");
    assert.throws(
      () => verifyTrusted(f.installation, f.repo, f.baseline),
      /installation source changed/,
    );
  } finally {
    f.cleanup();
  }
});

test("generated product artifacts in the installation cannot substitute for candidate outputs", () => {
  const f = fixture();
  try {
    // An ignored artifact from an old build is not part of the approved snapshot.
    writeFileSync(join(f.installation, "src/generated.ts"), "export const value = 1;\n");
    f.put("src/value.ts", "export { value } from './generated.ts';\n");
    const result = verifyTrusted(f.installation, f.repo, f.commit());
    assert.equal(result.decision, "failed");
    assert.ok(result.obligations[0]!.output.includes("generated.ts"));
  } finally {
    f.cleanup();
  }
});

test("zero, missing, skipped, todo, cancelled and failed TAP obligations do not pass", () => {
  const summary = "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.equal(testOutputPassed(summary), true);
  for (const output of [
    "",
    summary.replace("# tests 1", "# tests 0"),
    summary.replace("# pass 1", "# pass 0"),
    ...["fail", "cancelled", "skipped", "todo"].map((name) =>
      summary.replace(`# ${name} 0`, `# ${name} 1`),
    ),
  ])
    assert.equal(testOutputPassed(output), false);
});

test("timeouts and snapshot mutation fail even if an acceptance process could otherwise pass", () => {
  const f = fixture();
  try {
    f.put(
      "tests/value.test.ts",
      "import test from 'node:test'; test('slow', async () => { await new Promise(r => setTimeout(r, 5000)); });\n",
    );
    f.policy.obligations[0]!.timeoutMs = 50;
    f.put(".rcp/trusted-policy.json", JSON.stringify(f.policy));
    const slowCommit = f.commit();
    const slowInstall = join(f.root, "slow");
    installTrusted(f.repo, slowCommit, slowInstall);
    const slow = verifyTrusted(slowInstall, f.repo, slowCommit);
    assert.equal(slow.decision, "failed");
    f.put(
      "tests/value.test.ts",
      "import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('mutation', () => writeFileSync('src/value.ts', 'export const value = 99;'));\n",
    );
    f.policy.obligations[0]!.timeoutMs = 10000;
    f.put(".rcp/trusted-policy.json", JSON.stringify(f.policy));
    const mutateCommit = f.commit();
    const mutateInstall = join(f.root, "mutate");
    installTrusted(f.repo, mutateCommit, mutateInstall);
    const mutated = verifyTrusted(mutateInstall, f.repo, mutateCommit);
    assert.equal(mutated.decision, "failed");
    assert.ok(mutated.diagnostics.some((message) => message.includes("snapshot modified")));
  } finally {
    f.cleanup();
  }
});
