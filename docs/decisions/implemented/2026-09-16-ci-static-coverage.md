# The static gate names its surface, and stages the debt it cannot pay yet

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
with nothing referencing it, so the `tests/` surface is type-checked by no route at all;
running it with `--noUnusedLocals --noUnusedParameters` reports the unused code that the
reviewer's finding belongs to.

## Decision

**The lint surface is the four directories plus `tests/`, `evals/`, `scripts/` and
`tools/`.** `src/` is the only surface that reports as errors from day one, because it
was the only one already scanned. The three rules that fire on the newly scanned
research and script surfaces are reported at `warn`, named one rule per line in
`eslint.config.js` with the reason and how to retire the line. Disabling a rule for a
whole directory is not the mechanism: it removes the detection together with the
findings. Node globals are declared once through the `globals` devDependency, which is
what removes the 83 false findings.

**The exemption now applies where it was always aimed.** `no-console` is off for tests,
research harnesses, scripts and repository tooling, which print TAP output, measurement
progress and tool diagnostics by design, and on for product code.

**The surface is checked, not asserted.** `tests/tools/eslint-config-coverage.test.ts`
holds three properties: `lint` and `lint:fix` scan the same directories; every
directory-anchored `files:` block lies inside those directories; every such block still
matches a file that the script scans. It imports `eslint.config.js` and asks ESLint's own
`calculateConfigForFile` for the effective severity, so a comment cannot make it pass —
and its first check is red on the pre-change config, where `evals/**/*.ts` and
`scripts/**/*.ts` pointed outside the scanned surface.

**The debt is visible in CI without being blocking.** The required `static` job gains two
advisory steps, each with `continue-on-error` on the step rather than the job:
`npm run lint:debt` (the same ESLint invocation with `--max-warnings 0`, so the staged
findings are counted) and `npm run check:tests` (`tsc -p tsconfig.tests.json
--noUnusedLocals --noUnusedParameters`, which makes `tsconfig.tests.json` referenced for
the first time). Both are expected to fail until the debt is paid, both report a real
per-step result in the run, and neither joins the blocking set. A job-level
`continue-on-error` was rejected before, in
[2026-09-12](2026-09-12-visible-non-blocking-research-track.md): it makes a job in the
checks list indistinguishable from one that never ran. A step is not in that list, so
the distinction survives.

### The 11 findings staged on the newly scanned surfaces

| Surface | Rule | Findings |
| ------- | ---- | -------- |
| `evals/` | `@typescript-eslint/no-unused-vars` | `omnimemeval/experiment-manifest.mjs:134,190,191`, `omnimemeval/merge-embedding-caches.mjs:76`, `omnimemeval/research/probes/hyde-context.mjs:120`, `retrieval/profile-size.ts:36`, `retrieval/run.ts:38` |
| `evals/` | `no-useless-assignment` | `longmemeval/retrieval-evidence.ts:44`, `omnimemeval/research/probes/hyde-probe.mjs:167` |
| `evals/` | `preserve-caught-error` | `halumem/agent-extract.ts:145` |
| `scripts/` | `preserve-caught-error` | `sync-nmg-skill.ts:140` |

### The 23 findings on `tests/`, judged one by one

`tests/` gets no staged downgrade. Each finding is either a dropped assertion — the same
defect class as the review's `throws`, where a value was computed and never checked — or
dead code:

| Finding | Judgement |
| ------- | --------- |
| `core/graph-cycles.test.ts:120` (`m2`, `m3`, `m4` unused) | Dropped assertion. The chain's head and tail were checked and `size === 5` was asserted, so a 5-element set of the wrong records passed. The assertion is now set equality against `ids`. |
| `core/store/duplicates.test.ts:177` (`norm` unused) | Dropped assertion. Now asserts both same-normalized statements are retrieved, which is the sentence the neighbouring comment already claims. |
| `core/store/duplicates.test.ts:375,381` (`old2026`, `new2033` unused) | Dropped assertion. The as-of ranking was checked through statement substrings only; the two record ids are now asserted against the slots those substrings found, so the ranking cannot be satisfied by a different record. |
| `cli/service.test.ts:836,837` | Dead initializer. The ids are read after the `try`/`finally` that closes the service, so the `""` seed was never read; declared with a definite-assignment assertion like `tests/support/test-runtime.ts` already does. |
| `evals/longmemeval/retrieval-evidence.test.ts:24`, `evals/natural-maintenance-audit.test.ts:18` | Same dead initializer. |
| `cli/process.test.ts:3` (`mkdirSync`), `evals/omnimemeval-bridge.test.ts:8` (`NmgStore`) | Dead imports. Removed. |
| `evals/omnimemeval-judge-provider.test.ts:86` (`init` unused) | A fetch-stub parameter that is not inspected. Renamed `_init`, matching the config's `argsIgnorePattern`. |
| `extensions/nmg/index.test.ts:1457` (`error` unused) | The catch exists to retry a Windows handle release, not to inspect the error; `catch {` states that. |
| `integration/controller-channel.test.ts:79,118` (8 × `no-useless-escape`) | `\"` inside a template literal. Noise, and the escapes are removed. |
| `support/test-runtime.ts:104` (`prefer-const`) | Noise: the handler closes over the server it is built with; declared as a single `const`. |
| `chaos/chaos-storage-corruption.test.ts:41` | A stale `eslint-disable-next-line no-loop-func` that no longer suppresses anything. Removed. |

## Alternatives considered

- **Delete the dead `files:` block and stop.** Rejected: it removes the symptom (an
  inert exemption) and keeps the condition (surfaces no gate reaches). The review's
  finding would stay invisible.
- **Widen the surface and clear the ledger in the same change.** Rejected: the 11
  findings sit in research harnesses and a build script under concurrent work, and
  rewriting them here would fold unrelated eval logic into a lint change and make the
  review of both worse. The staged warnings keep the findings countable instead of
  dropped.
- **Silence the new surfaces by switching rules off for `evals/` and `scripts/`.**
  Rejected: that is the failure the guard test exists to prevent, and the ticket rules
  it out. A rule left at `warn` keeps reporting.
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
- The `tests/` surface is type-checked for the first time, by an advisory step whose
  failure count is the debt. `tsconfig.tests.json` is now referenced by a script instead
  of being an unread file.
- Staged warnings are real debt: they appear in every `npm run lint` run and as a red
  advisory step on every CI run. The exit criterion is written down — when
  `npm run lint:debt` reports no findings for the rules staged in `eslint.config.js`,
  delete those lines and move `lint:debt` into `verify:static`.
- Cost: the advisory steps stay red while the debt exists, which is honest but becomes
  wallpaper if nobody pays it down. The counter-pressure is that the count is printed
  every run and the staged lines are few and named.
- Cost: an advisory step proves nothing about whether the scheduled debt work happens;
  only the exit criterion and ordinary review do.
- Rollback: revert one commit. Nothing here migrates data or changes a runtime
  contract.

## Deferred

- `format:check` scans `src/`, `.pi/` and `workbuddy-plugin/` only. `tests/`, `evals/`,
  `scripts/` and `tools/` are still unformatted, and closing that hole needs its own
  Prettier pass.
- No route type-checks `evals/`, `scripts/`, or the `tools/` files outside the three
  names in `tsconfig.json`. `check:tests` is the first slice; the product surface with
  the same flags reports one error, so the same staged treatment is available for a
  later change.
- The 11 staged findings listed above.
