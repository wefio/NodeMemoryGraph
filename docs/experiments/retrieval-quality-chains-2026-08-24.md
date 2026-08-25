# Retrieval-quality chain pull (cross-block) — 2026-08-24

Follow-up to
[retrieval-quality-node-summaries-2026-08-24.md](retrieval-quality-node-summaries-2026-08-24.md):
the leafBlockRouting append now **walks one chain step from each selected
block member** — explicit edge endpoints (DAG chains) and position-adjacent
members (member-only chains, which is what eval `chainInjection: "logical"`
builds) — filling whatever budget the block members left. Targets the hardest
BEAM slice (event_ordering), where evidence spans several blocks.

Raw artifacts: `evals/results/retrieval/2026-08-24T09-27-28-389Z`
(hybrid+chains, summaries missing — see caveat) and
`2026-08-24T09-58-59-959Z` (stacked+node+chains, complete).

Runner change: `NMG_CHAIN_INJECTION=logical` is now part of the ingest
manifest reuse key (switching it re-ingests instead of comparing against a
differently-built store) and is recorded in the run manifest.

## Results (BEAM, R@20 / any@20 / all@20 / ctx chars)

| arm | R@20 | any@20 | all@20 | legacy evid | ctx chars |
| --- | ---: | ---: | ---: | ---: | ---: |
| stacked+node (08-24) | 27.4% | 65.1% | 26.4% | 29.3% | 51,110 |
| hybrid+chains (no summaries) | 27.7% | 74.9% | 35.7% | 40.2% | 124,844 |
| stacked+node+chains | **27.7%** | **80.0%** | **39.6%** | **46.1%** | **159,364** |

Event_ordering slice (n=40): R@20 15.6% → **17.4%**, any@20 57.5% →
**90.0%**, all@20 2.5% (unchanged), legacy evid 16.5% → 31.7%.
Summarization (n=36): any@20 66.7% → **94.4%**, all@20 0% → 8.3%.

## Reading

- Chains are a **coverage** win, not a ranking win: any@20 +14.9 pts and
  legacy evidence recall +16.8 pts over stacked+node, but R@20 moves only
  +0.3. The pulled chain neighbors rarely land inside the top-20 rank window
  that R@20 measures; they massively increase the chance that *something*
  relevant is in context.
- Event_ordering finally moves (15.6% → 17.4%, any@20 57.5% → 90.0%): the
  cross-block sequence continuation works as designed. all@20 ≈ 0 still —
  getting *every* gold of an ordering question into the pool needs more than
  one chain hop.
- **Context cost is now the blocker**: 159k chars ≈ 27× lexical (5.9k), 3.1×
  stacked+node. The main driver is the *ranked-results* chain pass
  (`expandChains`, bridge default) running **without
  `chainExpansionWindow`** — 90 chains average 63 members each and long
  dialog chains append whole conversations. The new block-member chain pull
  is budget-bounded (≤12 total); the unbounded pass is not.
- Next lever, unchanged but now urgent: a hard character budget for appended
  sections, plus setting `chainExpansionWindow` (e.g. ±3) in the bridge
  defaults. Either alone should cut most of the inflation; both together make
  chains deployable.

## Caveats

- The hybrid+chains row was an accident with signal: the Go monthly quota was
  exhausted mid-run (429, resets in ~13 days), the summary drain failed
  silently (`+0 generated`), and the run completed without any summaries. It
  doubles as an ablation of chains-without-summaries. The complete run used
  the DeepSeek official endpoint fallback (off-peak).
- Between the 08-18 and 08-24 runs, intermediate commits landed (see the
  node-summary doc); chained runs additionally re-ingested with
  `chainInjection: "logical"`. Same questions, same gold labels, same
  verbatim memories — but not bit-identical stores to the 08-18 rows.
