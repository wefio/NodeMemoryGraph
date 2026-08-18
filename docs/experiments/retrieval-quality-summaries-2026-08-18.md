# Retrieval-quality leaf-summary arm + stacked arm — 2026-08-18

Third formal run series of the pinned retrieval-quality protocol
(`evals/retrieval/`). Adds the leaf-block summary arm (`--summaries`) and the
stacked arm (`--hybrid --summaries`). Companions:
[retrieval-quality-baseline-2026-08-16.md](retrieval-quality-baseline-2026-08-16.md)
(lexical),
[retrieval-quality-hybrid-2026-08-16.md](retrieval-quality-hybrid-2026-08-16.md)
(hybrid + LME full-500).

Raw artifacts (`evals/results/retrieval/`):
`2026-08-18T07-24-21-871Z` (BEAM summaries), `2026-08-18T07-30-00-467Z`
(LoCoMo summaries), `2026-08-18T07-33-18-578Z` (LME-100 summaries),
`2026-08-18T08-08-57-163Z` (BEAM stacked), `2026-08-18T08-17-20-941Z`
(LoCoMo stacked). All arms reuse the same ingested stores per dataset, so
every paired number is same-data, same-memories.

## Mechanism (what is being measured)

After ingest, an external LLM writes one compact **semantic summary per leaf
block** (EPC-style evidence-preserving prompt, ≤180 words, prompt version
`leaf-summary-v1`, model `deepseek-chat`, thinking disabled). The summary is
**index metadata, not a memory**: it lives in nullable columns on
`memory_leaf_blocks` plus a `memory_leaf_fts` FTS5 table, is matched against
queries, and is never surfaced as a candidate or rendered into the context.
A hit pulls the block's **verbatim members** into an appended context section
(`leafBlockRouting`, ≤3 blocks, ≤12 members/block), after ranking, without
touching the ranking of the base pipeline — same contract as chain expansion.

Routing = block-summary FTS (bm25) merged with leaf-embedding vector routing
(when `--hybrid` also embeds leaf texts, preferring the summary as the
embedded document). Member selection v2: query-token overlap first (CJK
bigram shingles only for CJK), ordinal fill for the remainder of the block's
share, output ordered by ordinal so chronology is preserved.

Generation runs on the remember-triggered maintenance drain (daemon) and on
the benchmark's post-ingest pass via the same `drainLeafSummaries` helper, so
production and benchmark exercise the same code path. Summaries persist; the
fingerprint (`membersKey`) marks stale blocks, so re-runs regenerate nothing
(`+0 generated` on every repeat run above).

## Overall (R@20, ctx chars)

| dataset | lexical | hybrid | summaries | stacked |
| --- | ---: | ---: | ---: | ---: |
| LoCoMo (1532 q) | 24.1% (2184) | 29.3% | 34.0% (~4k) | **48.6%** (4333) |
| BEAM (235 q) | 16.9% (5877) | 21.8% | 20.0% (~30k, v1) | **27.0%** (48304) |
| LME-100 pinned | 75.9% (4274) | — | 77.6% (~20k) | — |

LME hybrid/stacked were not rerun on the pinned 100-question sample; the
full-500 reference from the hybrid doc stands (lexical 82.2% → hybrid 84.8%).

## Per-slice detail (R@20)

BEAM by capability, lexical → summaries → stacked:

| capability | n | lexical | summaries | stacked |
| --- | ---: | ---: | ---: | ---: |
| summarization | 36 | 5.3% | 8.5% | **15.9%** |
| event_ordering | 40 | 12.4% | 13.8% | **15.6%** |
| instruction_following | 40 | 11.5% | 23.1% | **25.0%** |
| multi_session_reasoning | 40 | 29.1% | — | **44.2%** |
| preference_following | 39 | 44.7% | — | **53.2%** |
| information_extraction | 40 | 35.3% | — | **51.5%** |

LoCoMo by category, lexical → summaries → stacked: cat-1 12.8% → — → 26.0%;
cat-2 31.6% → 40.9% → **62.0%**; cat-3 10.7% → — → 23.4%;
cat-4 35.1% → 51.7% → **70.7%**.

LME-100 by question type, lexical → summaries: single-session-user 97.1% →
97.1% (saturated); multi-session 61.0% → 64.0%.

## Cost: context inflation

The summary arm appends verbatim block members, so rendered context grows:

- **LoCoMo**: ~2.2k → ~4.3k chars (2×). Messages are short; inflation is
  bounded and clearly acceptable given +24.5 pts R@20 over lexical.
- **LME-100**: ~4.3k → ~20k chars. Modest quality gain (+1.7 pts); the LME
  miss mode is "gold in pool, ranked low", which block expansion does not
  target.
- **BEAM**: 5.9k → ~30k (summaries, v1 member selection) → 48.3k (stacked).
  BEAM messages are long, and v1 blindly ordinal-filled 12 members per block;
  v2 (query-overlap first) removed the noise-selection part, but the stacked
  arm still pays both the hybrid topK and the appended block sections.

Inflation is the price of verbatim recall and is only acceptable when bounded.
Current knob: `leafBlockRoutingMaxMembers` (default 12). Planned: a hard
character budget for the appended section so worst-case inflation is a
protocol constant, not dataset-dependent.

## Reading

- The summary arm's win concentrates exactly where the hybrid arm's miss mode
  was "wording shares nothing with the question": LoCoMo cat-4 (multi-hop,
  35.1% → 70.7% stacked) and BEAM summarization (5.3% → 15.9%). The block
  summary bridges the phrasing gap at index time instead of at query time.
- Summaries and embeddings are complementary, not substitutes: stacked beats
  either arm alone on both LoCoMo (48.6% vs 34.0/29.3) and BEAM
  (27.0% vs 20.0/21.8).
- LME barely moves (+1.7 pts): its misses are ranking misses inside the pool,
  not pool-coverage misses. Block expansion is the wrong tool there; ranking
  work (second pass, QPP) owns that gap.
- BEAM event_ordering remains the hardest slice (15.6% stacked): ordering
  questions need several blocks at once, and per-block expansion still
  surfaces one block's members at a time.

## Caveats

- The BEAM/LoCoMo summaries-only runs used member selection v1 (blind ordinal
  fill); stacked and all later runs use v2. Direction of the v1→v2 change is
  noise reduction, so the summaries-only numbers are conservative.
- Summary generation for these runs used the DeepSeek official endpoint
  (`deepseek-chat`). The endpoint is just a provider behind `NMG_SUMMARY_*`;
  the prompt version pinned in each manifest is what makes runs comparable.
- Same sample caveats as the baseline doc: LME-100 is not stratified; 165
  BEAM questions without gold labels are excluded.
