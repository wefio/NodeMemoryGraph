---
name: omnimemeval-eval
description: Run or resume NMG's OmniMemEval user-memory benchmarks through the config-driven shared workflow. Use for LongMemEval, LoCoMo, BEAM, PersonaMem v2, HaluMem, benchmark regression checks, or result continuation.
---

# OmniMemEval evaluation

Read this before the first run, after forgetting the workflow, or when resuming
a run. The stable source of truth is
`evals/omnimemeval/benchmark.config.json`; do not reconstruct its parameters on
the command line.

## Run

```powershell
# Inspect without model or embedding work.
npm run benchmark:omni -- longmemeval --dry-run

# Run one complete official suite.
npm run benchmark:omni -- longmemeval
```

Supported suite names are `longmemeval`, `locomo`, `beam`, `personamem-v2`,
and `halumem`. The runner generates a unique version, loads the configured env
file, establishes the NMG/UTF-8/venv environment, and delegates to the pinned
official script.

## Configure once

Edit the checked-in config when the experiment policy changes:

```json
{
  "envFile": ".env.nmg-opencode",
  "commonArgs": ["--workers", "1", "--llm-workers", "16", "--top-k", "20"],
  "suites": {
    "longmemeval": [],
    "beam": ["--scale", "100k"]
  }
}
```

`commonArgs` apply to every suite. `suites.<name>` forwards only that suite's
official options. Keep provider keys, model names, embedding endpoints, and QPP
configuration in the env file. Do not put runner-owned `--lib`, `--env`,
`--version`, or `--replay` flags in the config.

For a one-off canary, copy the config and select it explicitly:

```powershell
npm run benchmark:omni -- beam --config evals/omnimemeval/canary.config.json
```

Do not add a CLI flag merely to avoid editing or copying the config.

## Resume

Point at the exact existing result directory:

```powershell
npm run benchmark:omni -- --resume `
  .benchmarks/official/OmniMemEval/results/lme/nmg-<version>
```

The runner infers the suite and version from `experiment_config.sh`, verifies
that the run belongs to NMG, and rejects configured parameter drift. It removes
destructive lifecycle flags before delegating; the official pipeline resumes
its checkpoints. Do not infer a target from a similar directory name.

## Boundaries

- Do not call the five official scripts directly for normal NMG runs.
- Do not create a suite-specific NMG wrapper; add official arguments to config.
- Keep official parsing, prompts, scoring, checkpoints, and reports upstream.
- Keep NMG evidence audits separate from the official run.
- The runner does not start or kill embedding services, Pi, daemons, or Python
  processes.
- Use the official result artifacts to diagnose a failure; do not tune product
  retrieval solely to repair orchestration.

Historical scores and incident narratives belong in `docs/experiments/`, not
in this operating manual.
