# Formalized retrieval-quality benchmark

[English](README.md) | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

This document records the pinned local SQLite retrieval protocol and its results.
For new evaluations, use the [NMG HTTP guide](../omnimemeval/README.md).

## Protocol (pinned)

- **Retrieval path**: in-process `OmniMemEvalBridge` → shared
  `searchMemoryContext` → `store.searchContext` → shared exact-evidence Agent
  Surface. No benchmark-local retrieval or context renderer and no Python
  subprocess.
- **Retrieval mode**: the configured product path — record embeddings plus the
  bounded surface-anchor channel — is required and its `indexId` is recorded in
  the manifest. Ordinary word-level FTS remains a zero-configuration product
  fallback, not a benchmark arm. Surface anchors preserve explicit quoted
  phrases, paths, versions, IDs, error codes, code-like identifiers, and recall
  triggers through a contentless Unicode-normalized trigram index; plain prose
  does not become an anchor merely because English words overlap a gold answer.
  `--summaries` adds the leaf-block summary arm: after ingest, each block
  gets an LLM-written semantic summary (`NMG_SUMMARY_*` env, falling back to
  `NMG_JUDGE_*`; prompt version pinned in the manifest) and queries are routed
  over the block summary FTS index, pulling the block's verbatim members into
  the context (`leafBlockRouting`). A coarser node-summary tier (one summary
  per node, built from its block summaries, hysteresis-refreshed, ≥2
  summarized blocks to qualify) adds node FTS and node-vector routing behind
  the block hits.
  The summary text itself is index metadata and never appears as a candidate.
- **Budgets**: `topK = 20` mapped to the ranked evidence budget; appended chain
  and summary-routed evidence shares the smaller of a hard 16,000-character
  ceiling and `1024 + 0.75 × primary evidence characters`. Chain disclosure
  selects at most 4 MMR-diverse chains, follows at most one chain-intersection
  hop and two logical-DAG memory hops. Bridge defaults
  `secondPass: true`, `tieredDisclosure: true`, `maxTier: 3`, `graphHops: 1`,
  `expandChains: true`, `progressiveWarmDisclosure: false`.
- **Ingestion**: verbatim message storage (`statement = message.content`),
  no LLM supersession judge (deterministic). Stores persist under
  `.benchmarks/retrieval-stores/<dataset>/` and are reused across runs when
  the ingest manifest (dataset sha256 + sample rule) matches; mismatch or
  `--full`/`--limit` changes trigger a clean re-ingest. Dataset adapters
  normalize source-specific dates to ISO timestamps; Core keeps its strict
  temporal-validity contract.
- **Datasets and pinned samples** (from `.benchmarks/official/OmniMemEval/data/`):
  - LoCoMo (`locomo/locomo10.json`): all 10 users; category-5 adversarial
    questions excluded (same as the legacy audit).
  - LongMemEval-S (`longmemeval/longmemeval_s_cleaned.json`): first 100
    questions (`--full` for all 500).
  - BEAM (`beam/beam_100k.json`, 20-conversation JSONL): all 20
    conversations; `probing_questions` Python literals are parsed natively.
  - PersonaMem v2 (`personamem_v2/benchmark/text/benchmark.csv`): first 500
    questions (`--full` for all rows). Each selected persona's official 32K
    chat is ingested once; system instructions are excluded.
  - HaluMem Medium (`halumem/HaluMem-Medium.jsonl`): first 2 users (`--full`
    for all users). This is explicitly a **gold-memory retrieval arm**: official
    `memory_points` are the indexed records and question evidence names those
    same records. It measures routing/ranking over an extracted memory set, not
    extraction quality or paraphrase matching against raw dialogue.

## Gold matching

Normalization matches the legacy audits (lowercase, fold non-alphanumeric
runs, trim). A candidate carries two text parts — `statement` and a bounded
verbatim `evidenceExcerpt` — and a hit on either part counts.

- **LoCoMo / BEAM** (`gold-in-candidate`): gold = the source message text of
  `evidence` dia_ids / `source_chat_ids`; hit when the gold text appears
  inside a candidate part.
- **LongMemEval** (`candidate-in-gold`): gold = the whole `answer_session_ids`
  session blob; hit when a candidate part appears inside the gold blob, i.e.
  the candidate is backed by a gold session.
- **PersonaMem v2** (`gold-in-candidate`): gold = each message in the official
  `related_conversation_snippet`; hit when that source message appears inside a
  candidate part.
- **HaluMem** (`gold-in-candidate`): gold = each official evidence
  `memory_content`; questions with no evidence (for example Memory Boundary)
  remain in reports but are excluded from gold-based rates.

Namesakes is intentionally not adapted here: it is an entity-resolution corpus
without the query-to-source-evidence contract required by this rank-aware
retrieval scorer. Its topology evaluation remains under `evals/topology/`.

## Metrics

Per gold evidence the report records both its first rank in the ranked retrieval
prefix and its first position in the complete rendered window. Chain and block
members appended after ranking never acquire a ranked position.

- `R@k` (k = 1, 5, 10, 20): fraction of gold evidences hit within rank k.
- `any@20` / `all@20`: question-level any/all golds hit inside the ranked prefix.
- `any@full` / `all@full`: question-level any/all golds found anywhere in the
  rendered window, including unranked chain/block supplements.
- `MRR(Q)`: mean reciprocal rank of each question's first-hit gold.
- `legacy evid`: evidence recall over the rendered context, with the same
  definition as the legacy audits, for cross-checking against historical
  numbers.
- Cost: mean rendered-context characters; search latency p50/p95.

Metrics are stratified: LoCoMo by category, LongMemEval and HaluMem by
question type, BEAM by capability, and PersonaMem by preference type.

## Output and reproducibility

Reports land in `evals/results/retrieval/<run-id>/` (gitignored):
`report.json` (manifest + per-question id/query/ranks for spot checks) and
`table.md`. The manifest pins dataset sha256, git commit (+dirty flag), Node
and NMG versions, retrieval mode and every budget knob.

The historical setup and commands are in the
[archived retrieval README](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/retrieval/README.md).

## Environment

The environments and service settings for these results belong to the archived
local runner. For a NMG HTTP run, the selected service owns embedding and
retrieval configuration.

## Results

Formal run results are recorded as dated experiments under `docs/`:

- [Lexical tie ranking and neural ranker outcome](../../docs/experiments/retrieval-quality/lexical-tie-ranking-2026-09-30.md)
  — paired five-dataset lexical evaluation and the failed local neural ranking arm.

- [Retrieval-quality baseline 2026-08-16](../../docs/experiments/retrieval-quality/baseline-2026-08-16.md)
  — first pinned run, lexical arm, the original three-dataset protocol.
- [Retrieval-quality hybrid arm 2026-08-16](../../docs/experiments/retrieval-quality/hybrid-2026-08-16.md)
  — hybrid (external-embedding) arm on all three datasets + LME full-500
  runs for both arms; includes the supersede-scan O(N²) fix measurements.
- [Retrieval-quality summaries arm 2026-08-18](../../docs/experiments/retrieval-quality/summaries-2026-08-18.md)
  — leaf-block summary arm (`--summaries`) and stacked arm
  (`--hybrid --summaries`); LoCoMo R@20 24.1% → 48.6%, BEAM 16.9% → 27.0%.
- [Retrieval-quality node-summary tier 2026-08-24](../../docs/experiments/retrieval-quality/node-summaries-2026-08-24.md)
  — node summaries (from block summaries, hysteresis refresh); BEAM stacked
  27.0% → 27.4%, LoCoMo unaffected (degenerate 1-block nodes).
- [Retrieval-quality cross-block chain pull 2026-08-24](../../docs/experiments/retrieval-quality/chains-2026-08-24.md)
  — ±1-hop chain neighbors (edges + positional) pulled into the block-member
  budget; BEAM 27.4% → 27.7%, historical `any@full` (then mislabeled
  `any@20`) 65.1% → 80.0%, ctx 51.1k → 159.4k chars.
- [Retrieval-quality activation-gated chain expansion 2026-08-25](../../docs/experiments/retrieval-quality/chain-activation-2026-08-25.md)
  — whole-chain `expandChains` replaced by activation gating (proximity +
  query overlap + importance, hard cap); BEAM ctx 159.4k → 93.9k chars at
  ~40% of the coverage gain; event_ordering back to the no-chain level.
