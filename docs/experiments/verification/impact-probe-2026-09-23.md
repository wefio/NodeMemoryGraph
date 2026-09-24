# Import-impact verification probe — 2026-09-23

## Question and protocol

Can a dependency graph select a smaller product-test set for a change to
`src/core/simhash.ts` while preserving an honest account of what remains
unverified? This is a research probe, not an admitted verification route.

The probe inventories Git-visible TypeScript files, parses static imports and
exports plus literal `import()` and `require()` calls, follows reverse import
edges, and intersects reachable tests with the `test:product` file globs.
It hashes the inspected TypeScript files, `package.json`, `package-lock.json`,
`tsconfig.json`, and the Node version/platform/architecture before and after
candidate execution. It reports candidates with exit code 2, even when they
pass; exit code 1 means the candidate execution or planning failed.

Commands run from the repository root on Windows:

```text
rtk node --experimental-strip-types scripts/verification-impact-probe.ts --source src/core/simhash.ts --execute
rtk npm run test:product
rtk npm run agent:verify -- --full
rtk node --experimental-strip-types scripts/verification-impact-probe.ts --source src/core/simhash.ts
```

The candidate run and the subsequent full verifier used input digest
`8e861d5c8728603c07ae4aa5ebc04e3519294862b244426ed897440db04a1839`.

## Observation

| Run | Result | Elapsed |
| --- | --- | ---: |
| Import graph planning | 618 TypeScript files scanned; 14 candidate files of 175 product-test files | 0.7 s |
| Candidate test execution | Candidate tests passed; probe exited 2 (`candidate-only`) | 14.3 s |
| Full `test:product` within `agent:verify --full` | 1,532 tests passed | 85.1 s |
| Full `agent:verify --full` | All blocking checks passed; advisory research and chaos checks were skipped by policy | 137.3 s end to end |

The candidate execution was about six times faster than the product-test
portion of this full verifier run. This is a comparison of elapsed test
execution, not a reliability or
whole-verifier speedup claim. The current official gate also performs other
checks and was not replaced in this experiment.

## Coverage gaps and decision

The graph found three reachable tests outside `test:product` and four unresolved
imports, including computed module paths and a generated module. It does not
track JavaScript modules, file reads, generated inputs, environment dependencies,
or behavioral requirements. A fixture test demonstrates a test that reads the
changed source file without importing it; the graph omits that test. Other
fixtures check transitive and literal dynamic imports, changing input digests,
missing sources, and the nonpassing CLI exit status.

Therefore the 14 files are useful candidates for quick feedback, but their pass
cannot certify the SimHash change. The probe always reports
`fullGateRequired: true`. Before a subset can replace any blocking check, its
owner needs a declared input/dependency contract for that check, explicit
handling of unknown dependencies, and counterexample tests showing the selector
escalates when closure cannot be established. The full gate remains the
authoritative result for this experiment.
