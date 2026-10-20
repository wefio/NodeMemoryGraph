# LongMemEval Evaluation Workflow and Regression Check (2026-08-05)

[English](lme-eval-notes-2026-08-05.md) | [简体中文](lme-eval-notes-2026-08-05.zh-CN.md) · [Terms](lme-eval-notes-2026-08-05.terms.yaml)

**Status:** Dated historical evaluation record. The scripts, commands, and timings below describe the 2026-08 run and are not current workflow instructions. Use the [OmniMemEval evaluation skill](../../../.pi/skills/omnimemeval-eval/SKILL.md) and current configuration. Related: [PersonaMem v2 and forget-rendering record](../../design/pmv2-eval-forget-design-2026-08-05.md).

## Historical workflow and version contract

The recorded LongMemEval run used:

```bash
# Full pipeline: ingest + search + answer + judge + metric + report
bash evals/omnimemeval/run-lme.sh --env-file .env.nmg-bgefix --version lme500_bgefix_header_20260804

# Regression check: reuse store and resume
bash evals/omnimemeval/run-lme.sh --env-file .env.nmg-bgefix --version lme500_bgefix_header_20260804 --skip-ingest --llm-workers 16
```

For that runner, the version had to match the baseline exactly, including the `lme500` prefix. The report says the version determined the store's `userId` label: omitting the prefix selected a different store, yielding empty search evidence and a useless zero-recall result. The recorded preflight step was to inspect `results/lme/<baseline-directory>/experiment_config.sh` and copy `VERSION` verbatim.

The wrapper then fixed Python UTF-8 settings, `NMG_ROOT`, and stray-process cleanup. The note warned that directly invoking the upstream `run_lme_eval.sh` could lose `PYTHONUTF8` and fail when Rich printed a Unicode bullet to a GBK console. The embedding server on port 8000 was separate and was not killed by `run-lme.sh`.

The runner resumed by file existence: a complete `nmg_lme_responses.json` skipped answer generation, and a complete `nmg_lme_judged.json` skipped judging. A failed `--skip-ingest` retry repeated search (reported at about two minutes) and filled only incomplete answer/judge rows.

## Historical performance observations (16 workers, `deepseek-chat`)

| Stage | Before | After | Reported explanation |
|---|---:|---:|---|
| Answer, 500 questions | about 3 hours | 54 seconds | `atomic_json_dump` rewrote an 873 KB file with fsync per question; checkpointing every 25 questions reduced writes |
| Judge, 500 questions | 30+ minutes | 1–3 minutes | Similar write cost, plus repeated full `convert_numpy_types` conversion |
| Search, 500 questions | about 2 minutes | about 2 minutes | Not LLM-bound |

The report says 16-way concurrency achieved 9.3 requests/second with zero errors; the delay was attributed to per-question file dumps, not 429s. These timings are historical measurements, not current performance guarantees.

The local fork's recorded changes were:

- `scripts/longmemeval/lme_responses.py`: batch answer checkpoints every 25 questions.
- `scripts/longmemeval/lme_eval.py`: batch judge checkpoints every 25 questions.
- `scripts/utils/nlp_metrics.py`: make `extract_label_json` accept fields after `label`, e.g. `{"label": "WRONG", "reason": ...}`; the old regex reportedly caused 2/500 judge failures.

## Historical regression decision rule

The report backed up the baseline result directory, reran with the same version and `--skip-ingest`, then compared `experiment_manifest.json` results.

| Metric | Baseline | Historical decision rule |
|---|---:|---|
| `any_evidence_recall` / `evidence_recall` / `all_evidence_recall` | 94.15 / 87.95 / 82.67 | Require exact equality as the no-retrieval-regression check |
| `answer_accuracy` | 82.33 | Treat ±2 percentage points as judge variation; the report measured 28/498 relabel changes (5.6%) |

For the 2026-08-05 rerun, the report says all three recall values reproduced exactly after forget redaction and disclosure-layer reconstruction. Answer accuracy was 80.8 (-1.53 pp), within the stated judge-variation band. Answer text changed in 93% of rows after a disclosure-text adjustment, while recall was unchanged.

## Historical result location and limitations

The baseline and regression run were recorded under `results/lme/nmg-lme500_bgefix_header_20260804/`, with backup `_bak_bgefix_header_20260804`. The report describes earlier failures from the dump bug, a judge-extraction regex bug, and a manually omitted version prefix, followed by a final run in which judging completed 152/152 in 13 seconds.

These are results from that particular benchmark setup and local fork. They do not establish today's runner interface, current throughput, or general answer-quality stability. Current reproduction and configuration guidance belongs to the evaluation skill and `evals/omnimemeval/` owners.