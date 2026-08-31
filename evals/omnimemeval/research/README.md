# OmniMemEval research utilities

These files are diagnostic or hypothesis-testing utilities. They do not define
the public benchmark execution path, official prompts, or NMG runtime defaults.
Use the parent directory's `run.ts`, `benchmark.config.json`, `bridge.ts`, and
`README.md` for reproducible suite execution.

## Layout

- `audits/` — inspect completed result artifacts, retrieval coverage, QPP signals,
  and ranking distributions. They do not call an answer model unless their own
  command says so.
- `probes/` — bounded mechanism checks for retrieval, HyDE, progressive disclosure,
  MGR, and answer behaviour. Treat results as experimental evidence.
- `ablations/` — paired counterfactual arms such as reverse retrieval, pagination,
  and PersonaMem variants. They must not silently become product policy.
- `polarity/` — offline extraction, normalization, validation, and BEAM-specific
  polarity experiments.

The repository-level scripts intentionally expose only the maintained audit and
ablation entry points from `package.json`. Run an unlisted file directly only
when reproducing the experiment that owns it, and record conclusions in
`docs/experiments/` rather than promoting the script into a second benchmark
pipeline.
