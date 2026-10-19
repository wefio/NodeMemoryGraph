# Choose verification tracks and interpret static checks

[中文](verification-tracks.zh-CN.md) · [Terms used](verification-tracks.terms.yaml)

**Authority:** [Code quality and CI/CD](../ci-cd-and-quality.md).

## Verification tracks

Choose the entry for the behavior under test. Product correctness, research
characterization and fault injection are not interchangeable evidence. Running
one track does not imply the others ran. `package.json` owns exact command sets;
[the CI contract](../ci-cd-and-quality.md#ci-contract) owns triggering and aggregation.

### Choose a test or combined verification entry

| Command | Surface | Purpose |
| --- | --- | --- |
| `npm run test:product` | Core, CLI, adapters, docs, Skills, tools and test support | Product correctness. |
| `npm run test:coverage` | The product set plus coverage evidence | Blocking CI. |
| `npm run test:research` | `tests/benchmarks`, `tests/evals`, `tests/official` | Non-blocking research characterization. |
| `npm run test:chaos` | Windows fault injection and process/file-lock lifecycle | Separate blocking track. |
| `npm test` | All `tests/**/*.test.ts` | Complete local compatibility entry. |
| `npm run verify:static` | Build/package/type/mutation anchors/lint/format/docs/context/complexity | Shared local and CI contract. |
| `npm run verify:product-ci` | Build plus product coverage | Shared local and CI contract. |

A local run's plan and results determine which blocking/advisory checks actually
executed. A track name does not establish that every check ran. See the
[verification pipeline](../ci-cd-and-quality.md#agent-verification-pipeline)
for routing and failure handling.

### Use local analysis and automatic fixes deliberately

Three commands are intentionally local-only, not CI tracks: `npm run lint:fix`
uses the same ESLint surface as `lint` with `--fix`; `npm run hotspot:modules`
counts static call sites of store methods; `npm run perf:hotspots` prints
segmented latency shares from a store's `perf_aggregates`.

### Interpret lint and formatting coverage

`npm run lint` scans
`src/ .pi/extensions/ claude-plugins/ workbuddy-plugin/ tests/ evals/ scripts/ tools/`.
Account for these exceptions:

- `@typescript-eslint/no-unused-vars` and `no-useless-assignment` both detect
  values never read. In `tests/`, `evals/`, `scripts/` and `tools/`, they report
  `warn`; in `src/`, they remain errors. Other rules use the same standard on
  development surfaces and `src/`.
- Tests, research harnesses, scripts and tools print by design, so `no-console`
  is disabled on those surfaces.

Inspect liveness warnings for a missing consumer or assertion; do not simply
delete the clue to silence them. Three unused bindings in
`tests/core/graph-cycles.test.ts` were missing assertions, part of the rationale
for not promoting these two development-surface rules to blocking errors. See
[the static-coverage decision](../../decisions/implemented/2026-09-16-ci-static-coverage.md).

`tests/tools/eslint-config-coverage.test.ts` protects scanning coverage:
`lint` and `lint:fix` have the same surface, and every directory-anchored `files:`
block is covered and still matches files. ESLint supplies effective severities;
promoting a rule is a deliberate policy change.

`format` and `format:check` cover `**/*.ts` under `src/`, `.pi/`,
`workbuddy-plugin/`, `tests/`, `evals/`, `scripts/` and `tools/`. The staged format
hook shares that surface; subpackages retain their own workflow. Guard tests bind
both commands and the hook. Formatting does not repair deliberately incorrect
behavior in evaluation fixtures; the same decision owns this boundary.

### Separate type checking from mechanism-word checking

`npm run check:tests` runs
`tsc -p tsconfig.tests.json --noUnusedLocals --noUnusedParameters` and belongs to
the blocking `verify:static` and `ci-and-tests` sets. It checks `tests/`, standalone
`evals/ooo-execution/*.test.ts` harnesses, explicitly included source and imported
dependencies. Frozen `evals/ooo-execution/fixtures/` and archived evidence are not
independent compiler entries. Type-check inclusion does not imply default product
execution. `tests/tools/test-groups.test.ts` compares real compiler entries with
the on-demand selection list. This is not coverage of every `evals/`, `scripts/`
or `tools/` file; see the [recovery-test decision](../../decisions/implemented/2026-10-13-recovery-tests-use-frozen-declarations.md).

`check:policy-words` runs once in the blocking `verify:static` and `ci-and-tests`
sets. [Mechanism, not policy](../../decisions/implemented/2026-09-21-mechanism-not-policy.md#decision)
owns its vocabulary, classifications and scan surface. The check rejects
unregistered hits and record drift; it does not prove the mechanism layer has no
policy decisions.

### Separate mutation-anchor resolution from mutation testing

`mutation:anchors` in `verify:static` runs
`tools/mutation-teeth.ts --anchors-only`: it resolves every named mutant location
without running cases or writing files. Anchor resolution is not evidence that
mutation tests passed.

The check prevents stale anchors from disappearing silently: `mutation:teeth`
is not in a CI job, and a mutant whose location cannot be matched is reported as
inapplicable and excluded from the sweep denominator. The full sweep remains
outside the gate. It executes cases, costs minutes and is a standing pre-push
rule; [the decision](../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md)
owns its rationale and historical defects.

### Interpret complexity baselines and unmeasured files

`complexity:gate` in `verify:static` defaults to
`git merge-base HEAD origin/main`; `--base <ref>` overrides it. Check:

1. **Which baseline?** Each run reports it. A merge base includes committed branch
   changes; `HEAD` compares only uncommitted changes and can falsely report no
   change in a clean CI checkout.
2. **Which method?** AST object/class owners distinguish same-named methods,
   independently of line numbers. A map keyed only by ESLint's bare method name
   can reuse the wrong baseline. Dropping one method below the reporting threshold
   must not transfer its baseline to another; another owner's complexity debt
   must not mask growth. Existing thresholds and growth limits remain unchanged.
3. **Which changes were unmeasured?** Name them. ESLint rejection or parse failure
   can also yield zero findings; unmeasured is not measured-and-clean.

### Keep keyless tests isolated from ambient providers

`eval:*`, `benchmark:*`, live LLM/embedding and official large datasets do not run
in keyless CI. Research tests may verify adapters and scoring contracts, not use
external credentials or promote experiment constants into product defaults.

Tests that launch a daemon or MCP server must call `stripProviderEnv()` from
`tests/helpers/test-env.ts` at module top level, clearing
`NMG_EMBED*` / `NMG_SUMMARY*` / `NMG_JUDGE*`. The daemon inherits the test process
environment; an ambient provider such as `NMG_EMBED_PROVIDER=gemini` makes recall
slow, nondeterministic and dependent on an external service. A test that needs a
provider supplies its environment explicitly.

`tests/support/test-env-guard.test.ts` scans `tests/**/*.test.ts` for daemon-start
paths, including `connectDaemon(`, `StdioClientTransport`, `bin/nmg.mjs`, tutorial
scripts and the pi extension harness. A matching test without a module-top call
fails.

### Interpret coverage concurrency and liveness

The coverage track uses concurrency 2 to avoid memory peaks and false Windows
file-lock failures from c8 instrumentation plus cross-process/SQLite tests.
Ordinary product tests retain concurrency 4. The c8 0.01% line floor checks that
nonzero source evidence exists; it is liveness, not a coverage-quality target.
See [the decision](../../decisions/implemented/2026-09-23-coverage-evidence-liveness.md).
