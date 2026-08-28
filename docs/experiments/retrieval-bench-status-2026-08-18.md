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

Current invocation (the historical Shell wrapper has been removed):

```powershell
.benchmarks/bge-venv/Scripts/python.exe evals/omnimemeval/bge_server.py --device cuda
npm run eval:retrieval -- --dataset <datasets> --hybrid
```

Stores persist in `.benchmarks/retrieval-stores/<dataset>/` and are reused;
summaries persist too (membersKey fingerprint), so re-runs cost no LLM calls.

## Quota / provider state (as of 2026-08-18)

- **Go monthly quota ($60) is exhausted as of 2026-08-24, resets in ~13
  days** (`GoUsageLimitError`, 429). Until then all summary generation must
  use the DeepSeek official fallback (below). Symptom to recognize: a drain
  that finishes in seconds with `+0 generated` and no error — every call
  failed and the systematic-stop kicked in.
- LLM default: OpenCode **Go** subscription endpoint
  (`https://opencode.ai/zen/go/v1`, `deepseek-v4-flash`, key in `.env` as
  `OPENCODE_API_KEY`). Fallback: DeepSeek official (`DEEPSEEK_API_KEY` in
  `.env`):
  `NMG_SUMMARY_BASE_URL=https://api.deepseek.com NMG_SUMMARY_MODEL=deepseek-chat ...`
  (the TypeScript runner honors pre-set `NMG_SUMMARY_*` overrides).
- Go gateway ignores `thinking: {type:"disabled"}` (responses still carry a
  `reasoning` field) — expect higher per-call latency/cost than the official
  endpoint. Not yet worked around.
- Zen pay-as-you-go endpoint (`/zen/v1`) has **zero balance** — do not use.

## Store caveats

- `.benchmarks/retrieval-stores/longmemeval/` currently holds the **pinned-100
  ingest** (it overwrote the full-500 store). A full-500 run re-ingests.
- BEAM/LoCoMo/LME-100 all have summaries persisted; any arm reruns at search
  cost only.

## Done since

- **Node-summary tier** (2026-08-24): one summary per node built from block
  summaries, hysteresis refresh, node-FTS routing behind block hits. BEAM
  stacked 27.0% → 27.4%; LoCoMo unaffected by design (≥2-block gate,
  degenerate 1-block nodes). Details:
  [retrieval-quality-node-summaries-2026-08-24.md](retrieval-quality-node-summaries-2026-08-24.md).
- **Cross-block chain pull** (2026-08-24): after block-member selection, the
  remaining member budget (≤ `leafBlockRoutingMaxMembers`) pulls ±1-hop chain
  neighbors — explicit `memory_chain_edges` plus positional neighbors in
  `memory_chain_members` (needed because eval `chainInjection: "logical"`
  chains carry members only, no edges). BEAM stacked+node 27.4% → 27.7%,
  any@20 65.1% → 80.0%, all@20 26.4% → 39.6%, event_ordering 15.6% → 17.4%
  (any@20 57.5% → 90.0%). Cost: ctx 51.1k → 159.4k chars. Details:
  [retrieval-quality-chains-2026-08-24.md](retrieval-quality-chains-2026-08-24.md).
- **Activation-gated chain expansion** (2026-08-25): the `expandChains`
  default is no longer whole-chain — members are appended when proximity
  (1/(1+dist to nearest hit)) + query-term overlap + 0.5×importance reaches
  0.5, hard-capped by `chainExpansionMaxMembers` (default: ranked count).
  BEAM: R@20 27.7% → 28.9% (noise), ctx 159.4k → 93.9k chars, but only ~40%
  of the coverage gain survives and event_ordering falls back to the
  no-chain level. Constants fixed by principle, not benchmark-swept. Details:
  [retrieval-quality-chain-activation-2026-08-25.md](retrieval-quality-chain-activation-2026-08-25.md).

## Open work (not started)

- **Appended-section token budget (still open)**: activation gating cut BEAM
  ctx from 159.4k to 93.9k chars (~16× lexical), but there is still no hard
  protocol bound on the appended sections. Remaining levers: a character
  budget for the block-member section and a `leafBlockRoutingMaxMembers`
  sweep.
- **LME full-500 summaries arm**: needs re-ingest + ~24k summary calls —
  exceeds Go's per-5h flash quota (≈7,600 requests); needs quota planning or
  the DeepSeek fallback. Ask before launching.
- **BEAM event_ordering**: whole-chain expansion reached any@20 90.0% but
  undeployable ctx; activation gating is deployable but loses it (back to
  15.6%/57.5%). Density escalation was checked and rejected (2026-08-25):
  the ≥2-ranked-hits trigger fires on only 10% of ordering questions, and
  170/216 missed golds sit in sessions with no ranked hit at all. The binding
  constraint is cross-session first-hit recall, not within-chain expansion —
  further chain work has poor expected value here.
- **KV-cache friendliness**: prompts already keep a constant system prefix;
  next lever is batching several blocks per summary call (amortizes the shared
  prefix, cuts request count).
