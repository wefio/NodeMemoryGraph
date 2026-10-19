# Full verification with atomic static checks — 2026-09-23

[English](full-gate-atomic-checks-2026-09-23.md) | [简体中文](full-gate-atomic-checks-2026-09-23.zh-CN.md) · [Terms](full-gate-atomic-checks-2026-09-23.terms.yaml)

Evidence boundary (2026-10-17 documentation review): all timings, test counts,
check outcomes and tool/route descriptions below are historical observations on
their recorded inputs. They are not fresh checks of this documentation worktree.
No suite, gate, coverage run or benchmark was executed to produce this translation
review; missing run identity or snapshot details remain explicit uncertainties.

## Protocol

On the same Windows working tree and Node v24.19.0, run
`rtk npm run agent:verify -- --full` with the route's original nested
`verify:static` check, then with `ci-and-tests` declaring that contract's
atomic checks. The changed test asserts exact parity between the route's
atomic list and the package script. Both runs use the default 150-second
whole-run budget and execute all blocking checks; research and chaos checks
remain advisory. The working tree also contains the uncommitted whole-run
deadline changes and import-impact probe.

## Observation

| Plan | End to end | Product tests | Other checks and overhead | Blocking outcome |
| --- | ---: | ---: | ---: | --- |
| Nested static plus independent route checks | 137.3 s | 85.1 s | 52.2 s | passed |
| Atomic static checks, deduplicated by name | 102.3 s | 72.9 s | 29.4 s | passed |
| Atomic static checks after documentation update | 107.4 s | 72.4 s | 35.0 s | passed |

The first run reported eight blocking command results. The second reported
13 atomic results, each with its route attribution. The original
`verify:static` script contained six commands that the full plan also ran
independently. Their independent durations totalled 17.5 seconds in the first
run. The observed drop in non-product time was 22.8 seconds; run-to-run
variation and npm startup overhead prevent assigning all of it to the route
change. The original prose reported 12.3 seconds of product-test variation,
but the displayed rounded rows give 85.1−72.9 = 12.2 seconds for the first
comparison, or 85.1−72.4 = 12.7 seconds using the third row. The underlying
unrounded timing ledger was not rechecked; 12.3 is retained as a reported,
unresolved value rather than recomputed evidence.

The report records 1,533 passing product tests in the atomic run. The first two
rows form the original comparison; the third follows a documentation update,
not an identical-input repetition. These observations record duplicate execution
and an observed reduction;
they do not prove a worst-case bound below 150 seconds for every repository
state or machine. The final run includes the decision, design, and this
experiment document; it passed all 13 blocking checks. The full verifier
remains the source of the final verdict for that recorded experiment.
The 137.3/85.1-second pair also appears in the
[impact-probe report](impact-probe-2026-09-23.md). The summaries do not provide
distinct native run IDs for those matching values; do not count them as
independent replications merely because they appear in two documents.
