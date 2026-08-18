# Formalized retrieval-quality benchmark

One command, one pinned protocol, one table: `npm run eval:retrieval` measures
the single NMG retrieval pipeline (the same `store.searchContext` call path
used by automatic recall, `nmg_search`, the daemon, and the OmniMemEval
bridge) as a pure retriever, without an answer model or judge.

Existing audit scripts (`evals/omnimemeval/audit-*-retrieval.*`) measure text
coverage of the rendered context and lose rank information. This runner keeps
rank: every gold evidence records its first-hit rank inside the returned
candidates.

## Protocol (pinned)

- **Retrieval path**: in-process `OmniMemEvalBridge` → `store.searchContext`.
  No second call site, no Python subprocess.
- **Retrieval mode**: lexical (SQLite FTS5) by default — fully offline and
  deterministic. `--hybrid` enables the external-embedding arm
  (`NMG_EMBED_*` env) and records the `indexId` in the manifest.
  `--summaries` adds the leaf-block summary arm: after ingest, each block
  gets an LLM-written semantic summary (`NMG_SUMMARY_*` env, falling back to
  `NMG_JUDGE_*`; prompt version pinned in the manifest) and queries are routed
  over the block summary FTS index, pulling the block's verbatim members into
  the context (`leafBlockRouting`). The summary text itself is index metadata
  and never appears as a candidate.
- **Budgets**: `topK = 20` mapped to the evidence budget; bridge defaults
  `secondPass: true`, `tieredDisclosure: true`, `maxTier: 3`, `graphHops: 1`,
  `expandChains: true`, `progressiveWarmDisclosure: false`.
- **Ingestion**: verbatim message storage (`statement = message.content`),
  no LLM supersession judge (deterministic). Stores persist under
  `.benchmarks/retrieval-stores/<dataset>/` and are reused across runs when
  the ingest manifest (dataset sha256 + sample rule) matches; mismatch or
  `--full`/`--limit` changes trigger a clean re-ingest.
- **Datasets and pinned samples** (from `.benchmarks/official/OmniMemEval/data/`):
  - LoCoMo (`locomo/locomo10.json`): all 10 users; category-5 adversarial
    questions excluded (same as the legacy audit).
  - LongMemEval-S (`longmemeval/longmemeval_s_cleaned.json`): first 100
    questions (`--full` for all 500).
  - BEAM (`beam/beam_100k.json`, 20-conversation JSONL): all 20
    conversations; `probing_questions` Python literals are parsed natively.

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

## Metrics

Per gold evidence: first-hit rank (miss = none).

- `R@k` (k = 1, 5, 10, 20): fraction of gold evidences hit within rank k.
- `any@20` / `all@20`: question-level any/all golds hit.
- `MRR(Q)`: mean reciprocal rank of each question's first-hit gold.
- `legacy evid`: evidence recall over the rendered context, with the same
  definition as the legacy audits, for cross-checking against historical
  numbers.
- Cost: mean rendered-context characters; search latency p50/p95.

Metrics are stratified: LoCoMo by category, LongMemEval by question_type,
BEAM by capability.

## Output and reproducibility

Reports land in `evals/results/retrieval/<run-id>/` (gitignored):
`report.json` (manifest + per-question id/query/ranks for spot checks) and
`table.md`. The manifest pins dataset sha256, git commit (+dirty flag), Node
and NMG versions, retrieval mode and every budget knob.

```powershell
npm run eval:retrieval                          # all three datasets, pinned samples
npm run eval:retrieval -- --dataset locomo      # one dataset
npm run eval:retrieval -- --dataset longmemeval --full
npm run eval:retrieval -- --hybrid              # external-embedding arm
npm run eval:retrieval -- --summaries           # leaf-block summary arm (LLM endpoint)
```

Re-running with unchanged data and config reuses the ingested stores and
reproduces metrics bit-for-bit (only wall-clock latency varies).

## Environment

Canonical runner: `evals/retrieval/bench.sh <arm> <dataset[,dataset...]>`
(arms: `lexical` / `hybrid` / `summaries` / `stacked`). It sources `.env`,
sets the LLM endpoint, health-checks the embedding server, sets the LME heap,
and tees a dated log to `evals/results/retrieval/logs/`. Prefer it over
hand-assembled `npm run eval:retrieval` invocations so runs stay comparable.

Two external services, both configured by env (no models ship with NMG):

- **Embeddings (hybrid/stacked arms)**: BGE-small-en-v1.5 served by
  `evals/omnimemeval/bge-server.py` on `127.0.0.1:8000`. GPU setup (one time,
  PyTorch CUDA wheel ~3GB, venv lives in gitignored `.benchmarks/bge-venv`):
  ```bash
  uv venv .benchmarks/bge-venv
  uv pip install --python .benchmarks/bge-venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cu126
  uv pip install --python .benchmarks/bge-venv/Scripts/python.exe sentence-transformers fastapi "uvicorn[standard]"
  evals/retrieval/bench.sh server   # foreground; run as its own task
  ```
  `uv run --with` resolves PyPI's CPU-only torch on Windows and
  `uv run --torch-backend` is unsupported (uv 0.12) — hence the explicit
  venv. The server auto-selects CUDA and reports it on `/health`.
- **LLM (summaries arm / write-time judge)**: default is the OpenCode **Go**
  subscription endpoint `https://opencode.ai/zen/go/v1` with
  `deepseek-v4-flash` (`OPENCODE_API_KEY` in `.env`; included in the Go
  model list, zero data retention). Go quota: $12 per 5h / $30 per week /
  $60 per month; deepseek-v4-flash ≈ 7,600 requests per 5h. Fallback when
  quota is exhausted: DeepSeek official (`NMG_SUMMARY_BASE_URL=https://api.deepseek.com`,
  `NMG_SUMMARY_MODEL=deepseek-chat`, `NMG_SUMMARY_API_KEY=$DEEPSEEK_API_KEY`).
  Note: the Go gateway currently ignores `thinking: {type: "disabled"}` —
  responses carry a `reasoning` field anyway, so latency/cost per call is
  higher than the official endpoint with thinking off.

## Results

Formal run results are recorded as dated documents under `docs/`, not here:

- [Retrieval-quality baseline 2026-08-16](../../docs/experiments/retrieval-quality-baseline-2026-08-16.md)
  — first pinned run, lexical arm, all three datasets.
- [Retrieval-quality hybrid arm 2026-08-16](../../docs/experiments/retrieval-quality-hybrid-2026-08-16.md)
  — hybrid (external-embedding) arm on all three datasets + LME full-500
  runs for both arms; includes the supersede-scan O(N²) fix measurements.
- [Retrieval-quality summaries arm 2026-08-18](../../docs/experiments/retrieval-quality-summaries-2026-08-18.md)
  — leaf-block summary arm (`--summaries`) and stacked arm
  (`--hybrid --summaries`); LoCoMo R@20 24.1% → 48.6%, BEAM 16.9% → 27.0%.
