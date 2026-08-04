# LongMemEval re-run: recall-header refinement is format-only

2026-08-04. Verifies that the recall-header refinements (`819bd53`, `25a410f`,
`1a6210b`: `matches=` anchor instead of mechanism, event time + expiry fields,
slim `AG activeGraphId` line, one-line field legend) are format-only and do
not regress retrieval. Commit `82ec4c7` at run time; manifest in
`results/lme/nmg-lme500_bgefix_header_20260804/experiment_manifest.json`.

## Setup

- Config: `.env.nmg-bgefix` (fixed top-20, `NMG_QPP_SECOND_PASS=0`,
  `NMG_EMBED_PROFILE=bge-en`, BGE-small via offline server).
- Full pipeline run (ingest → search → answer → judge) through the new
  `evals/omnimemeval/run-lme.sh` flow, `--workers 1` (parallel bridge workers
  race on the embedding-cache schema lock), `--llm-workers 6`.
- Embedding cache `1e9807091681` (bge-en): 245,947 documents + 500 queries
  reused; no server calls needed.

## Results vs baseline (n=498 judged; baseline n=500)

| metric | baseline 08-03 | this run | delta |
|---|---|---|---|
| any-evidence recall | 94.15% | 94.15% | 0.00 |
| evidence recall (overall) | 87.95% | 87.95% | 0.00 |
| all-evidence recall | 82.67% | 82.67% | 0.00 |
| answer accuracy | 81.2% | 82.33% | +1.13 |

Retrieval metrics are bit-identical, as expected: the eval bridge builds its
context via `projectMemoryContext` (bridge.ts) and never reads the extension's
`formatSearchHeaders` output. The answer-accuracy delta is LLM/API run-to-run
noise on the same prompt and config.

## Process hardening landed on the way

- `evals/omnimemeval/run-lme.sh`: preflight (kill strays, env pins, cache
  coverage check), `--skip-ingest` guard with version-keyed store warning,
  `--from-step` resume, `--prune-stores` (user stores are keyed by
  `sha256(userId)` and the userId embeds the version label, so every run
  leaves ~500 fresh ~12 MB stores; pruning dropped the eval dir from 59 GB to
  7.3 GB), venv PATH for nltk.
- `evals/omnimemeval/embedding-cache.ts`: retry init DDL against transient
  SQLITE_BUSY from parallel bridge workers.
- `evals/omnimemeval/experiment-manifest.mjs`: per-run manifest with commit,
  prompt-template hashes (retrieval guidance, LME answer/judge prompts, NMG
  policy extension), runtime env + temperature, dataset sha256, and results
  with failure samples.
