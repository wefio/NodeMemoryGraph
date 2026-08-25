# Retrieval-quality node-summary tier — 2026-08-24

Follow-up to
[retrieval-quality-summaries-2026-08-18.md](retrieval-quality-summaries-2026-08-18.md):
adds the **node-summary tier** to the summaries arm. Node summaries are one
LLM-written index text per node, built **from the node's leaf-block summaries**
(never raw memories), persisted on `memory_nodes` + `memory_node_fts`, routed
by bm25. A node hit enqueues up to 2 of its blocks (largest first) into the
same ≤3-block, ≤12-member expansion budget; node-routed blocks expand even
without their own leaf summary. Refresh is hysteresis-driven
(≥5 new members, or ≥24h with any change), and a node only qualifies once it
has ≥2 summarized blocks — a 1-block node summary would duplicate the block
summary.

Raw artifacts: `evals/results/retrieval/2026-08-24T08-56-19-348Z`
(BEAM + LoCoMo, stacked = `--hybrid --summaries`).

## Results (R@20, stacked vs stacked+node)

| dataset | stacked (08-18) | +node (08-24) | ctx chars |
| --- | ---: | ---: | ---: |
| BEAM overall | 27.0% | **27.4%** | 48304 → 51110 |
| BEAM summarization | 15.9% | **17.0%** | — |
| BEAM event_ordering | 15.6% | 15.6% | — |
| LoCoMo overall | 48.6% | 48.6% (identical) | 4333 → 4333 |

BEAM: 90/90 nodes summarized (216 blocks / 90 nodes ≈ 2.4 blocks per node —
the multi-block structure the tier is designed for). Small but consistent
gains (+0.4 pts R@20, +0.8 any@20) at +2.8k ctx chars; generation cost was
90 short calls, one per node.

LoCoMo: **0/272 nodes summarized** — 297 blocks / 272 nodes ≈ 1.09 blocks per
node, so the ≥2-summarized-blocks rule excludes nearly all of them and the
run is bit-identical to the 08-18 stacked run. This is the design working as
intended, not a bug: LoCoMo's clustering is degenerate (nodes ≈ blocks), and
a duplicate-of-block node summary would only add index noise.

## Caveats

- Five commits landed between the two runs (reasoning-scratchpad lifecycle,
  retention/scope semantics, daemon concurrency). The BEAM delta is therefore
  "stacked+node with intermediate fixes" vs "stacked", not a pure A/B; the
  direction and size (+0.4) should be read as a small win, not a precise
  measurement.
- Latency columns are not comparable across the two dates (different machine
  state); quality metrics only.

## Reading

- The node tier earns its keep where nodes are genuinely multi-block (BEAM):
  near-free (one call per node, hysteresis-bounded) and a small recall gain.
- It does nothing for degenerate clusterings (LoCoMo) — correctly, by the
  minBlocks gate. If LoCoMo-style workloads matter, the lever is better
  clustering (fewer single-block nodes), not lowering the gate.
- BEAM event_ordering (15.6%) is untouched: node summaries surface the same
  blocks the block tier already found. Ordering questions need several blocks
  *jointly* — the next lever is cross-block chain pull at expansion time, not
  a coarser index tier.
