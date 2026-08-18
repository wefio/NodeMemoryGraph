# LoCoMo QPP safe-prefix evaluation (2026-07-29)

## Question

Does progressive QPP recall improve end-to-end answers when it starts from a
safe Top-20 prefix, rather than the earlier Top-1 experiment?

This run is intentionally label-free at inference time. Official evidence IDs
are used only by the post-run audit. QPP2 compression remains disabled because
the full evidence experiment showed that its 98% setting still removed evidence
on 77 questions.

## Configuration

- benchmark: OmniMemEval LoCoMo, all 1,540 questions
- memory corpus: the existing NMG record-vector corpus
- embedding: local `BAAI/bge-small-en-v1.5`
- answer model: `deepseek-v4-flash`
- judge model: `deepseek-v4-flash`
- official `top-k`: 20
- `NMG_QPP_SECOND_PASS=1`
- `NMG_QPP_INITIAL_EVIDENCE_TARGET=20`
- progressive ceilings: Fibonacci-compatible expansion within the existing
  bounded candidate pool
- result version: `qpp_i20_20260729`
- result directory:
  `.benchmarks/official/OmniMemEval/results/locomo/nmg-qpp_i20_20260729`

The benchmark report's environment snapshot does not yet include the two QPP
variables above. They are therefore recorded here as part of the reproducibility
contract.

## Retrieval evidence audit

| Metric                  | Fixed Top-20 reference | QPP safe prefix |    Change |
| ----------------------- | ---------------------: | --------------: | --------: |
| Any official evidence   |                  68.0% |      **79.74%** | +11.74 pp |
| All official evidence   |                  54.1% |      **66.49%** | +12.39 pp |
| Evidence recall         |                  52.9% |      **65.55%** | +12.65 pp |
| Mean context characters |                  4,458 |           7,956 |    +78.5% |
| Mean search latency     |                 314 ms |        1,325 ms |     4.22x |
| P95 search latency      |                 361 ms |        4,870 ms |    13.49x |

Category evidence recall for the QPP run:

| Category           | Recall |
| ------------------ | -----: |
| multi-hop          | 52.95% |
| temporal reasoning | 77.01% |
| open-domain        | 41.62% |
| single-hop         | 78.44% |

The fixed Top-20 values are the prior matched BGE K20 audit recorded by the
project. They were not regenerated in this run, so latency comparisons should
be treated as directional rather than as a controlled microbenchmark.

## Official answer score

The official OmniMemEval judge evaluated 1,536 questions; four were skipped by
the benchmark evaluator.

| Metric                   | Existing fixed Top-20 | QPP safe prefix |  Change |
| ------------------------ | --------------------: | --------------: | ------: |
| LLM-as-Judge             |                0.6480 |      **0.7435** | +0.0955 |
| F1                       |                     - |          0.3708 |       - |
| ROUGE-L                  |                     - |          0.3800 |       - |
| METEOR                   |                     - |          0.4226 |       - |
| Mean answer input tokens |                     - |         2,481.4 |       - |

QPP category answer scores:

| Category           | LLM-as-Judge |
| ------------------ | -----------: |
| multi-hop          |       0.6559 |
| temporal reasoning |       0.7570 |
| open-domain        |       0.5521 |
| single-hop         |       0.7893 |

The +0.0955 comparison uses the existing fixed Top-20 result. Because the
answer and judge calls were not rerun for that baseline in the same wall-clock
window, it demonstrates a strong end-to-end signal but is not yet a paired
judge-variance estimate.

## Decision

The experiment passes the quality gate: larger progressive recall produced a
substantial evidence-recall gain and the gain survived end-to-end answer
generation. The safe-prefix mode should remain an explicit bridge option while
the Pi default remains unchanged.

It does not pass the efficiency gate. The next QPP work should not enlarge the
pool further. It should:

1. batch or cache repeated local embedding work in the progressive loop;
2. record QPP parameters in OmniMemEval's environment snapshot;
3. make the first-stage budget head selective, because the full offline audit
   found almost no correlation with the oracle Fibonacci depth;
4. keep QPP2 in shadow until evidence retention is effectively lossless;
5. rerun a paired fixed Top-20 answer/judge arm only when judge variance or a
   publication-quality comparison is required.
