# Explicit search budget and neighboring turns

[简体中文](explicit-search-budget-2026-11-21.zh-CN.md) · [Terms used](explicit-search-budget-2026-11-21.terms.yaml)

The replay uses the shared search renderer, a 20-item ceiling, and cached
3∶1 log-odds scores for the same 1,867 questions and 3,351 gold labels as
the [fusion experiment](local-log-odds-fusion-2026-11-20.md). Character budgets
count UTF-16 units. Preview lengths count Unicode code points. Coverage
counts gold evidence reachable through displayed references.

| Preview | Character budget | Questions fitting 20 | Evidence coverage |
| ---: | ---: | ---: | ---: |
| 160 | 4,000 | 98.8% | 58.46% |
| 240 | 4,500 | 71.4% | 57.74% |
| 240 | 5,000 | 84.5% | 58.31% |
| 240 | 5,500 | 99.4% | 58.46% |
| 240 | 6,000 | 99.5% | 58.46% |
| 320 | 7,000 | 99.4% | 58.46% |

The 240-code-point tier exposes 42.35% of gold evidence in previews at 5,500
units. The 160-code-point tier exposes 23.37% at 4,000 units. The 320-code-point
tier exposes 51.60% at 7,000 units. The selected cap retains the 20-result
coverage while keeping the longer ordinary preview.

At 5,500 units, broadly recovering source order from benchmark metadata
gave 59.68% with two adjacent candidates. The narrower production replay
used primary evidence, a stored source session, an exact adjacent numeric
source ordinal, and query term overlap. It recovered 20 gold labels and
displaced 8, taking coverage from 58.46% to 58.82%.
The replay generated zero new embeddings.
