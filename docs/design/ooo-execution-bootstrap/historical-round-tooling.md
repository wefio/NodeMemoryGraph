# Historical S3/S4 round tooling and evaluation

[中文](historical-round-tooling.zh-CN.md) · [Terms used](historical-round-tooling.terms.yaml)

**Authority:** [Bootstrapping constrained OoO development](../ooo-execution-bootstrap.md).

historical implementation record; it does not assert current product-runtime integration.

## S3: usable entry point (historical record, completed 2026-09-12)

`round-spec.ts` described a round: baseline, checks, two task instruction/editable/visible sets, cases, declared failures, admission conclusion, prerequisites, budget/limits, and worker kind. `round-runner.ts` froze the spec into a round and made the run directory persistent; `round-cli.ts` exposed `submit`, `status`, and `cancel`.

A round could be repeated without editing the research script: run the same spec and record logs, then point `worker` at those logs for replay. `cancel` wrote to the round's own store. The live round polled it, self-cancelled, and killed in-flight check process trees. Another process read the same run directory for `status`.

The 2026-09-12 boundary update put the coordinator, round orchestration, host verification, and round records in `src/integration/ooo-{board,cycle,candidate,mutation,verifier,round-log}.ts`; `evals/ooo-execution/` retained research launchers (`live-*`, `round-{spec,runner,cli,compare}`) and tests. This was **not product-runtime integration**: it did not connect to `src/cli` or take over sessions by default.

Pi added a thin `ooo_round` tool, registered by default like other NMG tools. Cost was per call: `live` spent tokens; default replay used recorded answers without model cost. `submit` started separately; another process could use `status`/`cancel` on the same run directory. The tool bound an already reviewed entry point rather than reimplementing the coordinator. The operator authored specs, so spec paths were not treated as untrusted input.

On 2026-09-14, `ooo_round` left the product tool directory because ordinary collaboration did not need a dedicated tool; see G5 in `docs/design/task-unit-semantics-obligations.md`. Neither the former tool nor this historical record proves that the existing product `nmg_board` host path invokes the extracted programmatic dispatch loop.

## S4: comparative evaluation (historical record, tools and offline arms completed 2026-09-12)

`cycle.ts` added `mode: "ooo" | "sequential"`: the arms used the same plan, input, checks, and acceptance rules, changing only dispatch order. Mode became part of round identity, and replay could not cross modes.

`round-compare.ts` and `round-cli.ts compare --runs N` ran two arms, each with its own store, logs, and records. They reported quality (`verdicts`/`accepted`), wall time, host check count/time, covered waits, tokens, `cacheRead`, worker checks, killed/survived, failures, and reopen. Reports stated “do not compare time when the arms differ in quality”; a quality mismatch returned a nonzero exit code.

Live-model comparisons were **not done**: they require 2×N paid rounds and operator authorization. Offline arms replayed recorded answers, used zero model tokens, and measured scheduling/host overhead only.