# Staged Knapsack Packing and Pareto Frontier for Untruncated Full-Text Recall

[简体中文](fulltext-knapsack-pareto-2026-11-20.zh-CN.md) · [Terms](fulltext-knapsack-pareto-2026-11-20.terms.yaml)

## Question and Setup

Without truncating candidate statements (no 160/320 code-point preview cap), which packing
strategy maximizes annotated evidence recall across character budgets from 1,000 to 16,000
UTF-16 units, and how should strategies be combined across budget tiers?

- **Corpus**: Offline replay of 1,867 queries sharing the frozen three-route RRF pools (up to 100
  candidates, zero pinned hybrid slots, zero new embedding calls) from
  [Marginal Evidence Coverage](marginal-evidence-coverage-2026-11-20.md):
  - LoCoMo: 1,532 queries (2,348 gold items, short ~170-char turns)
  - BEAM: 235 queries (833 gold items, long ~3,000-char turns)
  - LongMemEval: 100 queries (170 gold items, medium-long ~1,000-char turns)
- **Rendering cost**: Compact `search` format (no `node=`, no default `type=`, backticked short
  `ref:...` keys without `memory=` / `preview=`, concise single-line header, no `count=`, 8-hex
  `activeGraphId` prefix), billed in UTF-16 units including fixed wrapper overhead.
- **Budgets**: 1,000 to 16,000 characters across 11 tiers.
- **Strategies**: `prefix_stop`, single-pass `rrf_fill`, monotonic `staged_rrf` (current
  baseline), unguarded length-density packing $\frac{40/(40+r)}{\max(L,100)^\alpha}$, and
  floor-guarded staged density packing $\frac{40/(40+r)}{\max(L,F)^\alpha}$ with $F \in \{400, 500\}$.

## Key Results (Gold Evidence Recall)

| Budget | Dataset | `staged_rrf` | `d0.50 (f=100)` | **`staged (f=400, α=0.5)`** | `staged (f=400, α=1.0)` |
|---:|---|---:|---:|---:|---:|
| 1,500 | LoCoMo / BEAM / LME | 49.2% / 14.8% / 74.7% | 34.8% / 17.4% / 75.9% | **49.3% / 16.6% / 77.7%** | 49.0% / 16.7% / 76.5% |
| 2,500 | LoCoMo / BEAM / LME | 56.2% / 19.7% / 84.1% | 48.9% / 21.7% / 83.5% | **56.4% / 20.8% / 84.1%** | 56.3% / 20.7% / 85.9% |
| 4,000 | LoCoMo / BEAM / LME | 63.3% / 23.3% / 90.6% | 60.0% / 25.9% / 90.0% | **63.4% / 23.9% / 91.2%** | 63.5% / 23.7% / 90.6% |
| 8,000 | LoCoMo / BEAM / LME | 72.7% / 32.1% / 92.9% | 72.2% / 33.9% / 95.3% | **72.6% / 33.1% / 95.3%** | 72.6% / 32.3% / 95.9% |
| 16,000 | LoCoMo / BEAM / LME | 81.0% / 36.6% / 94.7% | 81.1% / 38.7% / 98.2% | **81.0% / 38.5% / 97.7%** | 81.0% / 38.4% / 99.4% |

## Takeaways and Composite Tiering

1. **Why `floor=100` regressed on LoCoMo**: Penalizing 250-char informative turns against
   100-char short greetings caused a 7–19pp drop on LoCoMo under tight budgets (1,000–2,500 chars).
2. **A 400-char floor eliminates the short-record regression while keeping long-record gains**:
   Records at or below 400 chars compete strictly by RRF rank, while oversized multi-thousand-char
   records are penalized. Across 1k–16k budgets, `staged (f=400, α=0.5)` matches `staged_rrf` on
   LoCoMo while gaining +0.6 to +1.9pp on BEAM and +0.6 to +2.9pp on LongMemEval.
3. **RRF damping $k$ sweep (`floor=400, α=0.5`)**: Sweeping $k \in \{5, 10, 20, 30, 40, 50, 60, 100\}$
   shows a flat plateau across $k \in [30, 50]$ (within 0.6pp across all three datasets). $k=40$ sits
   in the center of the plateau and matches the existing `rankPrior` convention.
4. **Adopted renderer default**: Full-mode `packAutomaticRecall` uses floor-guarded monotonic staged
   knapsack ordering with **`k=40, floor=400, α=0.5`**, keeping economy-tier rows (≤160 code points)
   in strict retrieval order while preventing oversized full statements from starving concise hits.

## Scope

Offline annotated evidence recall only; end-to-end answer quality under a live host remains to be
evaluated. Raw sweep outputs and Pareto plots are archived in the local benchmark results directory
(`rag-fulltext-knapsack-pareto.json`, `rag-fulltext-knapsack-pareto.png`).
