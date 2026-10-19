# LongMemEval 94.15% Baseline Drift: Embedding Profile Regression (2026-08-03)

[English](longmemeval-profile-regression-2026-08-03.md) | [简体中文](longmemeval-profile-regression-2026-08-03.zh-CN.md) · [Terms](longmemeval-profile-regression-2026-08-03.terms.yaml)

**Status:** Historical benchmark report. The original scores were not reproduced in this documentation pass. Current source still selects `bge-en` by default for BGE-named models unless `NMG_EMBED_PROFILE` is explicitly set; this source fact does not revalidate the historical benchmark scores.

> **Conclusion:** The reported regression was attributed to embedding configuration drift, not a retrieval-mechanism change. Losing `NMG_EMBED_PROFILE` fell back to `qwen3`; applying its `Instruct: ... Query: ...` template to BGE queries degraded ranking. The report recorded LongMemEval any-evidence recall falling from **94.15% to 76.0%**. Restoring `NMG_EMBED_PROFILE=bge-en` reproduced 94.15%/87.95% in the historical run; dynamic QPP under the repaired configuration reported 95.19%/89.71%.

## Background

The historical LongMemEval any-evidence recall baseline was 94.15% in runs `nmg_lme500_bge_merged_20260728` and `nmg_bge_wide20_merged_20260801`. A fixed top-20 rerun in the later checkout produced 76.0%, an 18-point gap that initially suggested a code or vector-environment regression. This investigation attributed it to profile configuration.

## Diagnostic evidence chain

1. **Code ruled out:** rerunning the `ecdd661` wide20-era commit with fixed top-20 also yielded 76.0%, close to current B0. The report's diff from `ecdd661..HEAD` found no change in `base.ts` or selection logic.
2. **Data ruled out:** B0's store (user 5) had 469 records, 100% vector coverage, and the target evidence record.
3. **Ranking difference measured:** for the same query, “What was my last name before I changed it?”, against the same store:
   - `profile=qwen3` (default): evidence ranked **14**, outside the top-12 token-truncated context;
   - `profile=bge-en`: evidence ranked **5**;
   - `profile=plain`: evidence ranked **9**.
4. **Hash provenance:** the report says the then-current embedding-cache index hash `e84bb38b824d` was generated on 08-03; `e20245358378` (1,645 rows) from 08-01 was only a debugging session. It reproduced the profile-to-hash mapping: `qwen3` → `e84bb38b824d`; `bge-en` → `1e9807091681`.
5. **Full-run check:** with `NMG_EMBED_PROFILE=bge-en` and fixed top-20, the report recorded any-evidence recall **94.15%**, overall **87.95%**, with category results matching the historical run: knowledge-update 100.00/99.31, multi-session 97.60/85.63, temporal 88.64/83.01.

## Root cause and source correction

The report traced the issue to `commonOpenAiOptions` in `src/core/embedding-providers/openai.ts`: a default `qwen3` profile had been used regardless of model unless `NMG_EMBED_PROFILE` was set. The BGE model (`BAAI/bge-small-en-v1.5`) expects the query template `Represent this sentence for searching relevant passages: {text}`; the Qwen3 wrapper `Instruct: {instruction}\nQuery:{text}` shifted BGE query embeddings and degraded ranking. The historical run environment had an explicit profile (or a different default), which disappeared during an environment-file rewrite around 08-02/03.

The recorded fix chose a model-sensitive default: model names containing `bge` use `bge-en`; other models use `qwen3`; explicit `NMG_EMBED_PROFILE` still wins. The current implementation in [`src/core/embedding-providers/openai.ts`](../../../src/core/embedding-providers/openai.ts) and [`tests/core/embedding-provider.test.ts`](../../../tests/core/embedding-provider.test.ts) retains that behavior. Tests cover BGE default, explicit override, non-BGE `qwen3`, and index-ID distinction.

## Historical LongMemEval matrix (n=479, any-evidence recall)

| Configuration | Any | Overall | Answer accuracy | Mean records | Note |
|---|---:|---:|---:|---:|---|
| Historical baseline (07-28 / 08-01 wide20) | 94.15% | 87.95% | — | ~12 | `bge-en` + fixed top-20 |
| Repaired fixed top-20 | 94.15% | 87.95% | 81.2% | 15.1 | Exact reproduction reported |
| **Repaired dynamic init13 (no strong hit)** | **95.19%** | **89.71%** | **82.3%** | 20.5 | Higher than fixed baseline in this run |
| Drift-period fixed top-20 (`qwen3` default) | 76.0% | 62.3% | — | 12 | Drift-period comparison |

The report says dynamic QPP init13 with Fibonacci progression and strong-hit disabled exceeded fixed top-20 in this matrix: any +1.04 percentage points, overall +1.76 pp, answer accuracy +1.1 pp (81.2% → 82.3%). Category answer-accuracy changes included single-session-preference 73.3 vs 66.7 (+6.6 pp), single-session-assistant 98.2 vs 94.6 (+3.6 pp), knowledge-update 86.8 vs 84.6 (+2.2 pp), and multi-session 75.8 vs 74.4 (+1.4 pp); single-session-user (-1.5 pp) and temporal (-0.7 pp) regressed slightly. The mean record count rose from 15.1 to 20.5, so token use was higher during QPP progression.

## Lessons recorded

- Embedding profile/template errors can be silent: no exception, only poorer ranking. An index-ID hash change and full cache invalidation were early signals of configuration drift.
- Before comparing a historical baseline, verify that its configuration is reproducible. In this case the report attributed the 18 pp gap to configuration rather than retrieval mechanism; same-commit reruns and category-level comparisons helped localize it.
- Defaults should account for the model family: BGE → `bge-en`, rather than applying a Qwen3 template to every OpenAI-compatible endpoint.

All benchmark values here remain attached to the historical dataset, configuration, and run; the source-level default alone is not a new benchmark receipt.