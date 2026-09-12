// Host-side probe: which declared mutants does the frozen check actually kill?
// Run: node --experimental-strip-types evals/ooo-execution/mutation-probe.ts
// Point MUTATION_SPEC at a JSON {paths?, checks?, mutants} file to probe a candidate
// fault class before a round declares it; without it the built-in list is used.
import { readFileSync } from "node:fs";
import { verifyCandidate, type CandidateCheck } from "../../src/integration/ooo-candidate.ts";
import { mutate, type Mutation } from "../../src/integration/ooo-mutation.ts";

const repository = process.cwd();
const revision = process.env.MUTATION_REVISION ?? "HEAD";
const impl = "src/integration/ooo-check.ts";
const defaultPaths = [
  impl,
  "evals/ooo-execution/check-events.test.ts",
  "evals/ooo-execution/board-admission.ts",
  "evals/ooo-execution/patch-verifier.ts",
  "evals/ooo-execution/patch-cycle.test.ts",
  "src/integration/ooo-execution.ts",
  "src/integration/ooo-patch.ts",
];
const defaultChecks: readonly CandidateCheck[] = [
  {
    label: "protocol-regression",
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      "--test",
      "evals/ooo-execution/check-events.test.ts",
      "evals/ooo-execution/patch-cycle.test.ts",
    ],
  },
];

interface Spec {
  paths?: readonly string[];
  checks?: readonly CandidateCheck[];
  mutants: readonly Mutation[];
}

const external = process.env.MUTATION_SPEC;
const spec: Spec | null = external ? (JSON.parse(readFileSync(external, "utf8")) as Spec) : null;
const paths = spec?.paths ?? defaultPaths;
const checks = spec?.checks ?? defaultChecks;
const files = Object.fromEntries(paths.map((path) => [path, readFileSync(path, "utf8")]));

export const mutants: readonly Mutation[] = spec
  ? [...spec.mutants]
  : [
      {
        id: "sameCheck-ignores-attempt",
        path: impl,
        from: "    actual.attempt === expected.attempt &&\n",
        to: "",
      },
      {
        id: "sameCheck-ignores-expiry",
        path: impl,
        from: "    actual.owner === expected.owner &&\n    actual.expiresAt === expected.expiresAt\n",
        to: "    actual.owner === expected.owner\n",
      },
      {
        id: "sameCheck-loose-owner",
        path: impl,
        from: "    actual.owner === expected.owner &&",
        to: "    (actual.owner === expected.owner || true) &&",
      },
      {
        id: "sameCheck-ignores-digest",
        path: impl,
        from: "    actual.inputDigest === expected.inputDigest &&\n",
        to: "",
      },
      {
        id: "checkResultValid-accepts-empty-outcome",
        path: impl,
        from: '    ["passed", "failed", "undecidable"].includes(result.outcome) &&',
        to: "    true &&",
      },
      {
        id: "checkResultValid-off-by-one-log",
        path: impl,
        from: 'Buffer.byteLength(result.log, "utf8") <= 4_000',
        to: 'Buffer.byteLength(result.log, "utf8") < 4_000 - 1',
      },
    ];

const baseline = await verifyCandidate({ repository, revision, files, checks });
console.log(`baseline: ${baseline.verdict}`);
for (const mutation of mutants) {
  const result = await verifyCandidate({
    repository,
    revision,
    files: mutate(files, mutation),
    checks,
  });
  console.log(
    `${result.verdict === "accept" ? "survived" : result.verdict}: ${mutation.id} ` +
      `(${result.outcomes.map((item) => `${item.label}=${item.status}`).join(", ")})`,
  );
}
