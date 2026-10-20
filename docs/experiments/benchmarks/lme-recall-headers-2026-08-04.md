# LongMemEval re-run: recall-header refinement is format-only

[English](lme-recall-headers-2026-08-04.md) | [简体中文](lme-recall-headers-2026-08-04.zh-CN.md) · [Terms](lme-recall-headers-2026-08-04.terms.yaml)

Evidence boundary (2026-10-17 documentation review): this is a historical
experiment record. The configurations, measurements, implementation descriptions
and follow-up proposals below are scoped to that experiment. This review did not
rerun the experiment or independently revalidate its original artifacts; these
are not current test receipts, default-policy decisions or general guarantees.

The 2026-08-04 report compared retrieval metrics after the recall-header refinements (`819bd53`, `25a410f`,
`1a6210b`: `matches=` anchor instead of mechanism, event time + expiry fields,
slim `AG activeGraphId` line, one-line field legend). It reported unchanged
retrieval metrics, within the bridge path described below. Commit `82ec4c7` at run time; manifest in
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

The report records bit-identical retrieval metrics and describes a bridge path
that builds context via `projectMemoryContext` (bridge.ts), without reading the
extension's `formatSearchHeaders` output. That comparison does not exercise or
validate the changed Pi header renderer. The answer-accuracy delta cannot be
attributed to that renderer; this unpaired run does not isolate LLM/API variance.

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
