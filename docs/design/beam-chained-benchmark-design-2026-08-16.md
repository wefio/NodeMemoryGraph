# BEAM Chained-Benchmark Design and Report (2026-08-16)

[English](beam-chained-benchmark-design-2026-08-16.md) | [简体中文](beam-chained-benchmark-design-2026-08-16.zh-CN.md) · [Terms](beam-chained-benchmark-design-2026-08-16.terms.yaml)

Historical synthetic-chain benchmark report. The results below are reported by the dated note; its raw run artifacts are not linked here and were not reproduced in this documentation pass. Do not treat them as product-runtime or real-world chain-quality evidence.

## Question and evaluation setup

The note recorded a 400-question BEAM `idtime` run with a new parameter set: overall Nugget `0.6568`, `event_ordering` `0.1892`, and `summarization` `0.4652`. The imported BEAM memories had no chain memberships, so the run did not measure chain expansion or logical-chain presentation. The weak `event_ordering` score was observed in the no-chain setup and cannot be attributed to chains.

The experiment explicitly constructed synthetic chains during benchmark ingestion. This was benchmark construction, not runtime inference. It compared the same questions and judge protocol with no injected chain, temporal, logical, or both-chain setup. A synthetic logical chain approximated message order as causal order; it did not establish the quality of naturally authored chains.

## Reported results

| Injection | Overall | `event_ordering` | `summarization` | `info_extraction` | `multi_session` | `temporal_reasoning` | `instruction` |
|---|---:|---:|---:|---:|---:|---:|---:|
| none (baseline) | 0.6568 | 0.1892 | 0.4652 | 0.7668 | 0.6595 | 0.6000 | 0.8000 |
| temporal | 0.6755 (+1.87 pp) | 0.2173 | 0.6958 | 0.8764 | 0.7363 | 0.5687 | 0.8125 |
| logical | 0.6867 (+3.0 pp) | 0.2379 | 0.6891 | 0.8458 | 0.6400 | 0.6896 | 0.8708 |
| both | 0.5624 (-9.4 pp) | 0.0269 | 0.3181 | 0.7792 | 0.4530 | 0.6771 | 0.7125 |

These are sample-bounded values from the report, not a current benchmark receipt. The report did not link its raw run files in this document.

## Interpretation limits

- In this single protocol, the reported temporal and logical single-chain scores were higher overall than the no-chain score; `both` was lower. This does not establish a general chain-quality or product-benefit result.
- In the studied `idtime` setup, temporal chains were not rendered as a chain block, while the bridge enabled chain expansion. The report attributed the single-chain change mainly to retrieved neighboring evidence, but the design did not isolate that causal mechanism from other context effects.
- The large `both` drop is consistent with context dilution, but the table alone does not prove that explanation. It also does not transfer automatically to the current bounded append-budget implementation.
- The proposed rule “expand only the most relevant chain” is a follow-up hypothesis, not a product contract. Current chain expansion is caller-selected and bounded; see [the current chain source contract](temporal-logical-chains-design-2026-08-13/converged-design.md).

## Current evaluation-code boundary

The current OmniMemEval bridge keeps synthetic chain injection explicit and defaults it to `none`. Its active injection block handles `logical`; the `temporal`/`both` branch is retained as commented experiment history. The bridge's chain setup and retrieval options are evaluation instrumentation, not product-runtime behavior. See [`evals/omnimemeval/bridge.ts`](../../evals/omnimemeval/bridge.ts), [`src/core/store/retrieval.ts`](../../src/core/store/retrieval.ts), and [the chain design history](temporal-logical-chains-design-2026-08-13.md).

The original protocol also listed open questions about long-chain windows, logical-order approximation, DAG branching, and separating retrieval expansion from rendering. They remain research questions unless a current owner and experiment settle them.