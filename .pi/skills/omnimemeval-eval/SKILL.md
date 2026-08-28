---
name: omnimemeval-eval
description: Run or resume NMG's OmniMemEval user-memory benchmarks through the single supported workflow. Use for LongMemEval, LoCoMo, BEAM, PersonaMem v2, HaluMem, benchmark regression checks, or result continuation.
---

# OmniMemEval evaluation

Use this as a technical manual. Read it before the first benchmark run, after
forgetting the workflow, or when resuming or specializing a run. Historical
scores and incident narratives belong in `docs/experiments/`, not here.

## Supported entry point

All five user-memory suites use one command:

```powershell
npm run benchmark:omni -- <suite> --env <env-file> [common options] [-- suite-options]
```

Supported suites are exactly `longmemeval`, `locomo`, `beam`,
`personamem-v2`, and `halumem`.

Do not call a suite's official `run_*_eval.sh` directly. The NMG runner sets
`NMG_ROOT`, UTF-8 Python variables, the shared venv path, and uniform
concurrency defaults before delegating to the pinned official script. It does
not change the benchmark's parser, prompt, scorer, checkpoint format, or report.

## Normal run

```powershell
# Inspect the exact command without spending model or embedding resources.
npm run benchmark:omni -- longmemeval --env .env.nmg-opencode --dry-run

# Run the complete official pipeline.
npm run benchmark:omni -- longmemeval --env .env.nmg-opencode `
  --version lme-canary-20260827
```

Common defaults are:

- ingestion/search workers: `1` (protects the NMG single-writer bridge);
- answer/judge concurrency: `16`;
- retrieval `top-k`: `20`;
- answer runs: `1`;
- pipeline start: step `1`.

Use explicit common flags to override them. Keep provider keys, model names,
embedding endpoints and QPP configuration in the selected env file. Confirm an
external embedding endpoint is healthy before a paid or full run; the runner
does not start or kill external services.

## Dataset-specific options

Place dataset-only flags after `--`. The boundary is deliberate: a BEAM scale
or HaluMem range must not silently become policy for every suite.

```powershell
npm run benchmark:omni -- beam --env .env.nmg-opencode `
  --version beam-canary --llm-workers 32 -- `
  --scale 100k --judge-batch-size 4

npm run benchmark:omni -- halumem --env .env.nmg-opencode `
  --version halumem-canary -- `
  --variant medium --users 2 --start-user 0
```

Run with `--help` or `--dry-run` to see the accepted boundary. If an official
suite adds an option, add it to `SUITES` in `evals/omnimemeval/run.ts` and add a
contract test; do not create a new wrapper.

## Resume without mixing stores

`version` is the benchmark/store identity. A continued run must name the exact
old result directory as independent evidence that the old stage completed:

```powershell
npm run benchmark:omni -- longmemeval --env .env.nmg-opencode `
  --version lme-canary-20260827 --from-step 2 `
  --resume-dir .benchmarks/official/OmniMemEval/results/lme/nmg-lme-canary-20260827
```

For `--from-step > 1`, the runner fails unless:

1. both `--version` and `--resume-dir` are present;
2. the directory is under the selected suite's result root;
3. `experiment_config.sh` records `LIB="nmg"` and the exact version;
4. the required preceding checkpoint artifact exists and is non-empty.

Never infer a resume target from a similar directory name. Never bypass this
check with a new one-off script. OmniMemEval's official interactive replay is
available through `--replay <result-dir>`.

## Concurrency and batching

The official pipeline owns checkpointing, grouping and concurrent answer/judge
work. Increase `--llm-workers` only inside the existing shared pool; do not
launch one process per question or recursively restart whole suites. Use
`--from-step`, `--to-step`, and suite range options for bounded canaries.

Before a paid or full run:

1. run `--dry-run` and verify suite, env, version, and range;
2. inspect the official result directory/checkpoint if resuming;
3. choose a small canary range when the suite supports it;
4. monitor the first group before allowing the pool to continue.

## Results and diagnosis

Official execution, scoring and report artifacts stay under the pinned
OmniMemEval checkout. NMG-specific evidence audits are separate commands such
as `benchmark:audit:locomo`, `benchmark:audit:beam`, and
`benchmark:audit:longmem`; they must not mutate the official run.

When a run is slow, distinguish ingestion/search bridge latency, embedding
endpoint latency or cache misses, answer/judge provider latency, checkpoint
writes, and failed retries or provider throttling.

Do not change product retrieval or official prompts merely to repair benchmark
orchestration. Fix the shared runner or the pinned fork's generic stage logic,
then add a contract or regression test.
