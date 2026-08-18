# Retrieval benchmark — working state & resume guide (2026-08-18)

Continuity note: everything needed to resume the retrieval-quality work in a
fresh session without re-discovery. Protocol definition and environment setup
live in `evals/retrieval/README.md`; run results live in the dated
retrieval-quality documents next to this one. This file is the "where are we"
layer.

## Where we are

Four arms of the pinned protocol are run and recorded:

| dataset | lexical | hybrid | summaries | stacked |
| --- | ---: | ---: | ---: | ---: |
| LoCoMo (R@20) | 24.1% | 29.3% | 34.0% | **48.6%** |
| BEAM (R@20) | 16.9% | 21.8% | 20.0% | **27.0%** |
| LME-100 pinned (R@20) | 75.9% | — | 77.6% | — |

Details, per-slice tables, cost analysis:
[retrieval-quality-summaries-2026-08-18.md](retrieval-quality-summaries-2026-08-18.md)
(+ the baseline/hybrid docs it links).

Code state: leaf-block summaries feature complete and tested (612+16 tests
green, tsc clean). Member selection is **v2** (query-token overlap first,
ordinal fill, chronological output); the summaries-only BEAM/LoCoMo numbers
were measured with v1 and are conservative. Key knobs:
`SearchOptions.leafBlockRouting`, `leafBlockRoutingMaxMembers` (default 12),
prompt version `leaf-summary-v1` in `src/integration/leaf-summarizer.ts`.

## How to run anything

```bash
evals/retrieval/bench.sh server            # BGE embedding server (GPU), own task
evals/retrieval/bench.sh <arm> <datasets>  # lexical|hybrid|summaries|stacked
```

Stores persist in `.benchmarks/retrieval-stores/<dataset>/` and are reused;
summaries persist too (membersKey fingerprint), so re-runs cost no LLM calls.

## Quota / provider state (as of 2026-08-18)

- LLM default: OpenCode **Go** subscription endpoint
  (`https://opencode.ai/zen/go/v1`, `deepseek-v4-flash`, key in `.env` as
  `OPENCODE_API_KEY`). Connectivity verified 2026-08-18 (200 OK, cost $0
  against subscription quota).
- **The Go weekly quota ($30) is nearly exhausted.** When calls start failing
  with 429/quota errors, either wait for the weekly reset or fall back to the
  DeepSeek official endpoint (`DEEPSEEK_API_KEY` in `.env`):
  `NMG_SUMMARY_BASE_URL=https://api.deepseek.com NMG_SUMMARY_MODEL=deepseek-chat ...`
  (bench.sh honors pre-set `NMG_SUMMARY_*` overrides).
- Go gateway ignores `thinking: {type:"disabled"}` (responses still carry a
  `reasoning` field) — expect higher per-call latency/cost than the official
  endpoint. Not yet worked around.
- Zen pay-as-you-go endpoint (`/zen/v1`) has **zero balance** — do not use.

## Store caveats

- `.benchmarks/retrieval-stores/longmemeval/` currently holds the **pinned-100
  ingest** (it overwrote the full-500 store). A full-500 run re-ingests.
- BEAM/LoCoMo/LME-100 all have summaries persisted; any arm reruns at search
  cost only.

## Open work (not started)

- **Appended-section token budget**: BEAM stacked ctx is 48.3k chars (~8×
  lexical). Add a hard character budget for the block-member section so
  worst-case inflation is a protocol constant (`leafBlockRoutingMaxMembers`
  sweep is the cheap first step).
- **LME full-500 summaries arm**: needs re-ingest + ~24k summary calls —
  exceeds Go's per-5h flash quota (≈7,600 requests); needs quota planning or
  the DeepSeek fallback. Ask before launching.
- **BEAM event_ordering** (15.6% stacked) and **summarization** (15.9%) remain
  the hard slices; per-block expansion surfaces one block at a time, ordering
  questions need several. Candidates: cross-block chain pull at expansion time.
- **KV-cache friendliness**: prompts already keep a constant system prefix;
  next lever is batching several blocks per summary call (amortizes the shared
  prefix, cuts request count).
