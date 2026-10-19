# Lexical Tie-Breaking Under a Small Budget

[English](lexical-budget-2026-10-10.md) | [简体中文](lexical-budget-2026-10-10.zh-CN.md) · [Terms](lexical-budget-2026-10-10.terms.yaml)

## Frozen protocol

Baseline: `94ca7e8f8000fb275e73961b25ba0c517e2f63df`. This slice studies only the position of FTS5 tie-breaking; it does not change candidate generation, scores, gates, default result count, QPP parameters, or output format. The user confirmed the public test boundary as `NmgStore.search` / `searchContext`; the shared `searchMemoryContext` entry verifies no-embedding and locally simulated degradation paths without calling a network model.

| Cell | Comparison question | Fixed check |
|---|---|---|
| Ties under a small budget | When a full-statement hit ties a node-name-only hit, does truncation occur before sorting? | The same two-row fixture selects the same target first at `limit=1/2`; check both public interfaces |
| Truncation across direct candidates | Can the target be pushed out by `searchContext`'s intermediate truncation? | A tie fixture with more than the default 20 direct candidates retains the full-statement hit at `limit=1` |
| Non-ties and stability | Does the change cross raw-score boundaries or perturb records with equal coverage? | Non-tie order, equal-coverage input order, and existing unit contracts do not regress |
| Chinese | Does the rule work only for English fixtures? | An independent Chinese fixture passes through the same public interfaces; no production memory IDs |
| Irrelevance, scope, and time | Does sorting add candidates or bypass filters? | No-hit remains empty; scope, expired-record, and historical-query constraints remain |
| Shared entry and audit | Do no-provider and degradation paths preserve budget and attribution? | Same target selected; IDs/order agree across AG, selections, and trace; degradation code is preserved |
| Semantic negative control | Does the lexical change affect hybrid retrieval? | Fixed local-vector fixture is unchanged; no live embedding call |

Each cell compares baseline with one candidate, without adding a third arm; per-cell results are retained rather than reporting only an average. Exit conditions: the small-budget tie fixture changes from red to green, negative controls do not regress, and static/product gates pass. These are controlled contract checks, not production noise-rate or answer-quality acceptance.

## Diagnostic evidence

A DAP inspection passed on the baseline's existing lexical-tie fixture in `tests/core/store/retrieval.test.ts`: for query `Atlas SQLite`, the node-hit side statement `The store uses WAL` and the full statement `Atlas SQLite stores project data` both had `combinedScore` 22.

- `searchContext(limit=1)` returned only the side statement; `limit=2` put the full statement first.
- `search(limit=1/2)` also returned the side statement first.
- Existing sorting happened only after AG selection and therefore could not change the already-truncated set. This proves a small-budget truncation limitation; it does not prove that this was the full cause of the earlier real AG recall failure, nor that coverage among all FTS5 ties means relevance.

## Results

One small-budget regression failed on baseline (0/1) and passed after the change (1/1). Three targeted test files passed 49 tests, including Chinese, 25 tied candidates across direct truncation, non-ties, no-hit, scope/expiry/history filters, no provider, locally simulated provider failure, semantic negative control, and existing open-record contracts.

A fixed two-arm CPU comparison was also run: an in-memory database generated 2/25/100/500 tied candidates, each queried at `limit=1/2` via `search` and `searchContext`. Each cell was warmed twice, then the arms ran in alternation for 10 iterations each, yielding 32 arm-level aggregates. The target was the unique row whose statement contained the complete query; side rows matched only in the node name. The baseline's first result was the target in 1/16 cells; the candidate did so in 16/16. This is a synthetic fixture with a known target, not natural retrieval precision or a production noise rate.

| Tied-pool size | `limit=1` `search` median ms (baseline → candidate) | `limit=1` `searchContext` median ms (baseline → candidate) |
|---:|---:|---:|
| 2 | 0.546 → 0.603 | 0.847 → 0.868 |
| 25 | 1.001 → 1.150 | 1.528 → 1.830 |
| 100 | 2.450 → 2.866 | 2.745 → 3.785 |
| 500 | 20.302 → 23.257 | 11.523 → 13.946 |

At `limit=2` with 500 rows, `search` measured 11.573 → 15.735 ms, the largest observed median increase in this run (~4.16 ms); it is not a general upper bound. Timings include a full local store query, not only sorting. The candidate keeps the original coverage rule for ties and adds no model, threshold, or production memory ID.

The full local numeric receipt is `.nmg/verification/lexical-budget/paired-probe.json`; it records measurement time, both arm roots, baseline HEAD, source hashes, and per-iteration timings. The one-run probe script was removed. The first full gate failed: the new worktree had not been built, so product tests depending on `dist` failed; an added inline condition also increased complexity in two existing large methods. The code explicitly built and moved the mode check into a private sorting function without relaxing the complexity threshold. The final source then reran the same CPU protocol. The first-failure receipt remains at `.nmg/verification/lexical-budget/first-failed.json`.

All 16 blocking checks in the final `agent:verify` passed; product tests: 1689/1689; LSP on three changed source/test files: 0 diagnostics; complexity threshold remained 15. The internal success receipt from the second run was `0206d7f4-bf54-41ec-9e9e-85512970527b`, but the outer task tool timed out, so it was not treated as a normal exit. The same gate was run again in an isolated synchronous subprocess with separated stdio; receipt `6afd8345-1da2-43fd-9993-937b809dcd39`, process exit=0, signal=null. The exit proof is `.nmg/verification/lexical-budget/verify-exit.json`. Research/chaos advisory checks were not run. No production deployment, paid judge, live embedding, or full benchmark was performed.

## Boundaries

- This moves an existing lexical rule earlier; it does not solve cases where correct evidence never enters the FTS candidate pool.
- Token coverage is not semantic truth, and IDF varies with each stage's candidate pool; there is no claim that ranking prefixes are universally stable at all budgets.
- QPP parameters were unchanged, but its selected evidence and stopping decision may change.
- The shared lexical entry was validated through controlled active and automatic interfaces; no replay through real harnesses was run.
- Output slimming, automatic trigger/abstention policy, and model-gate version differences are outside this slice; there was no deployment or daemon restart.