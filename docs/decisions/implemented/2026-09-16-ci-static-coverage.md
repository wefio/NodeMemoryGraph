# The static gate names its surface, and leaves liveness findings to a human

[中文](2026-09-16-ci-static-coverage.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [A non-blocking track must still be visible](2026-09-12-visible-non-blocking-research-track.md)

## Problem

A third-party review reported an unused `throws` declaration in
`evals/ooo-execution/live-continuation.ts`. The finding was real, and no gate this
repository owns could have produced it:

- `npm run lint` scanned `src/ .pi/extensions/ claude-plugins/ workbuddy-plugin/`.
- `npm run check` type-checks the `tsconfig.json` include, which holds `src/`,
  `.pi/extensions/`, `claude-plugins/` and three files under `tools/` — not `tests/`,
  not `evals/`, not `scripts/`, not the rest of `tools/`.
- `npm run format:check` covered the same three directories as before.

The inert part was worse than the missing part. `eslint.config.js` already carried
`files: ["**/*.test.ts", "evals/**/*.ts", "scripts/**/*.ts"] → no-console: off`, and it
applied to nothing: the four scanned directories contain no `*.test.ts`, and `evals/`
and `scripts/` were never scanned. A `files:` block outside the lint script's surface is
not a weaker exemption; it is an exemption that never ran, and nothing could tell it
apart from one that did.

Two further measurements set the size of the change. Widening the surface with the
config as it stood produced 83 `no-undef` findings in the eight
`evals/omnimemeval/**/*.mjs` probes, all false: the config declared no Node globals, so
`process`, `console` and `fetch` read as undefined. And `tsconfig.tests.json` existed
with nothing referencing it, so the `tests/` surface is type-checked by no route at all.

## Decision

**The lint surface is the four directories plus `tests/`, `evals/`, `scripts/` and
`tools/`.** Node globals are declared once through the `globals` devDependency, which is
what removes the 83 false findings, and the `no-console` exemption names the directories
it was always aimed at: tests, research harnesses, scripts and repository tooling print
TAP output, measurement progress and diagnostics by design.

**The two liveness rules are advisory on the developer surfaces and stay errors on
`src/`.** `@typescript-eslint/no-unused-vars` and `no-useless-assignment` both assert
that a value is never read — the judgement a static tool is most likely to get wrong
about code that is alive. It was wrong about this change's own first pass: the three
unused bindings in `tests/core/graph-cycles.test.ts` were a missing assertion, not dead
code, and the same class produced four more of the `tests/` findings below. Under a
blocking rule the cheapest way to a green gate is to delete the hint. So on `tests/`,
`evals/`, `scripts/` and `tools/` those two rules report and do not fail; on `src/` they
fail, and did before this change. Promoting one back to an error is a deliberate edit to
one line plus the severity the guard test pins.

**The surface is checked, not asserted.** `tests/tools/eslint-config-coverage.test.ts`
holds three properties: `lint` and `lint:fix` scan the same directories; every
directory-anchored `files:` block lies inside those directories; every such block still
matches a file that the script scans. It imports `eslint.config.js` and asks ESLint's own
`calculateConfigForFile` for the effective severity, so a comment cannot make it pass.
Its first check is red on the pre-change config, where `evals/**/*.ts` and
`scripts/**/*.ts` pointed outside the scanned surface.

**Static checking and the unused-code scan run in CI, and the debt does not block.** The
required `static` job runs the widened `lint`: liveness findings appear as warnings and
as annotations on the run, and never fail the build, while everything else is held to the
same standard as `src/`. One advisory step, `npm run check:tests`, runs
`tsc -p tsconfig.tests.json --noUnusedLocals --noUnusedParameters` — the first reference
to `tsconfig.tests.json` — because no blocking route type-checks `tests/`. It is expected
to fail while its pre-existing type errors are paid down; `continue-on-error` sits on the
step, not on the job, so its findings appear as annotations and its exit code is in the
job log while the required aggregate stays green. A job-level `continue-on-error` remains
rejected by [2026-09-12](2026-09-12-visible-non-blocking-research-track.md): there the
objection was a job whose real result could not be told apart from one that never ran, so
the detail is emitted as annotations rather than swallowed.

### What the first widened scan reported

The scan's first pass over the newly covered surface produced 11 findings. Nine were
genuinely dead and were deleted; two were not dead code at all:

| Finding                                                  | What it was                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evals/omnimemeval/experiment-manifest.mjs:133,134`      | `llmClientText` and the `llmClientPy` path that only fed it; the parameters it looked like it was for are read by `paramIn`. Deleted.             |
| `evals/omnimemeval/experiment-manifest.mjs:181,190,191`  | `correct` and `anyHit` counters incremented every iteration and never read; the category breakdown uses `byCat` instead. Deleted.                 |
| `evals/omnimemeval/merge-embedding-caches.mjs:52,76`     | `kept`, and the `wasMissing` it counted; the summary reports duplicates as `total - finalCount`. Deleted.                                         |
| `evals/omnimemeval/research/probes/hyde-context.mjs:120` | `userId`, superseded by the `storeUserId` the store is actually keyed by. Deleted.                                                                |
| `evals/retrieval/profile-size.ts:36`                     | An unused `catch (e)` binding. `catch {`.                                                                                                         |
| `evals/retrieval/run.ts:38`                              | An unused `NODE_SUMMARY_PROMPT_VERSION` import. Deleted.                                                                                          |
| `evals/longmemeval/retrieval-evidence.ts:44`             | `let traceId: string \| null = null` — the seed was never read, because every path that reads `traceId` exits through the assignment. Dead store. |
| `evals/omnimemeval/research/probes/hyde-probe.mjs:167`   | `let hydeCtx = baseCtx` — assigned before every read. Now a `const` inside the branch that assigns it. Dead store.                                |
| `evals/halumem/agent-extract.ts:145`                     | Not dead code: a rejected extraction rethrows a new error without the parse failure that caused it. `{ cause: error }` keeps the symptom.         |
| `scripts/sync-nmg-skill.ts:140`                          | Not dead code: the lock-contention error dropped the `EEXIST` it was raised for. `{ cause: error }`.                                              |

### The 23 findings on `tests/`, judged one by one

Five of these were reported as dead code and were actually dropped assertions — the
evidence behind the advisory severity above:

| Finding                                                                                         | Judgement                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/graph-cycles.test.ts:120` (`m2`, `m3`, `m4` unused)                                       | Dropped assertion, not dead code. The chain's head and tail were checked and `size === 5` was asserted, so a 5-element set of the wrong records passed. The assertion is now set equality against `ids`.                    |
| `core/store/duplicates.test.ts:177` (`norm` unused)                                             | Dropped assertion. Now asserts both same-normalized statements are retrieved, which is the sentence the neighbouring comment already claims.                                                                                |
| `core/store/duplicates.test.ts:375,381` (`old2026`, `new2033` unused)                           | Dropped assertion. The as-of ranking was checked through statement substrings only; the two record ids are now asserted against the slots those substrings found, so the ranking cannot be satisfied by a different record. |
| `cli/service.test.ts:836,837`                                                                   | Dead initializer. The ids are read after the `try`/`finally` that closes the service, so the `""` seed was never read; declared with a definite-assignment assertion like `tests/support/test-runtime.ts` already does.     |
| `evals/longmemeval/retrieval-evidence.test.ts:24`, `evals/natural-maintenance-audit.test.ts:18` | Same dead initializer.                                                                                                                                                                                                      |
| `cli/process.test.ts:3` (`mkdirSync`), `evals/omnimemeval-bridge.test.ts:8` (`NmgStore`)        | Dead imports. Removed.                                                                                                                                                                                                      |
| `evals/omnimemeval-judge-provider.test.ts:86` (`init` unused)                                   | A fetch-stub parameter that is not inspected. Renamed `_init`, matching the config's `argsIgnorePattern`.                                                                                                                   |
| `extensions/nmg/index.test.ts:1457` (`error` unused)                                            | The catch exists to retry a Windows handle release, not to inspect the error; `catch {` states that.                                                                                                                        |
| `integration/controller-channel.test.ts:79,118` (8 × `no-useless-escape`)                       | `\"` inside a template literal. Noise, and the escapes are removed.                                                                                                                                                         |
| `support/test-runtime.ts:104` (`prefer-const`)                                                  | Noise: the handler closes over the server it is built with; declared as a single `const`.                                                                                                                                   |
| `chaos/chaos-storage-corruption.test.ts:41`                                                     | A stale `eslint-disable-next-line no-loop-func` that no longer suppresses anything. Removed.                                                                                                                                |

## Alternatives considered

- **Delete the dead `files:` block and stop.** Rejected: it removes the symptom (an inert
  exemption) and keeps the condition (surfaces no gate reaches). The review's finding
  would stay invisible.
- **Hold every rule on the newly covered surface at error.** Rejected: the two liveness
  rules are the ones whose judgement the findings above show to be unreliable on this
  code, and a blocking gate answers an unreliable finding by deleting the code it points
  at. Reporting them costs nothing; failing on them would.
- **Silence the new surfaces by switching rules off for `evals/` and `scripts/`.**
  Rejected: that is the failure the guard test exists to prevent. A rule left at `warn`
  keeps reporting; a rule switched off stops.
- **Leave the 11 findings in place as staged warnings.** Rejected once each was read: nine
  were dead code, which is what the scan exists to remove, and the other two were a
  dropped error cause. Staging them would have been paperwork over a ten-line fix.
- **Satisfy "warnings, not blocking" with a job-level `continue-on-error`.** Rejected by
  the precedent in [2026-09-12](2026-09-12-visible-non-blocking-research-track.md), and
  it would duplicate the job that already exists rather than report something new.
- **Hand-write the Node globals instead of adding `globals`.** Rejected: a hand list
  recreates the exact defect being fixed — one missing global reports every use as
  undefined for as long as nobody notices.
- **Guard the config by reading it as text.** Rejected: comments and formatting would
  decide the result, which is what the ticket means by "a comment must not be able to
  fail".
- **Widen `format:check` in the same change.** Deferred, not rejected: it is the same
  class of hole, but it needs a Prettier pass over the newly covered directories, and a
  formatting rewrite of research code would bury the lint change it travels with.

## Consequences

- A file under `tests/`, `evals/`, `scripts/` or `tools/` can no longer be added without
  being linted, and a `files:` block can no longer be anchored outside the scanned
  surface or match nothing.
- Unused imports, unused variables and dead stores are reported on every developer
  surface. Nine of them are gone with this change, and the next one is visible in the run
  as a warning annotation rather than as a merge blocker.
- The `tests/` surface is type-checked for the first time, by an advisory step whose
  failure count is its debt. `tsconfig.tests.json` is now referenced by a script instead
  of being an unread file.
- Cost: an advisory finding that nobody reads is not a gate. The counter-pressure is that
  the findings are annotated on the diff and counted in the run, and the guard test keeps
  the severities themselves from drifting silently.
- Rollback: revert one commit. Nothing here migrates data or changes a runtime contract.

## Deferred

- `format:check` scans `src/`, `.pi/` and `workbuddy-plugin/` only. `tests/`, `evals/`,
  `scripts/` and `tools/` are still unformatted, and closing that hole needs its own
  Prettier pass.
- No route type-checks `evals/`, `scripts/`, or the `tools/` files outside the three
  names in `tsconfig.json`. `check:tests` is the first slice; the product surface with
  the same flags reports one error, so the same treatment is available for a later
  change.
- `check:tests` reports 69 pre-existing type errors (37 under `tests/`, 26 in
  `workbuddy-plugin/nmg-hook.ts`, 5 under `evals/`, 1 under `tools/`). None of them is a
  liveness finding; paying them down and moving the step into `verify:static` is its own
  change. The count is a property of the tree, not of the step: the tree that merges
  `feat/ooo-run-namespace` measures 74 (41 under `tests/`, everything else unchanged), the
  four extra findings being that branch's own test files. Whoever merges it re-measures this
  line rather than carrying 69 forward.
