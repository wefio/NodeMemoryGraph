# Full verification with atomic static checks — 2026-09-23

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
change. Product tests varied by 12.3 seconds without a product-test change.

The atomic run passed 1,533 product tests and every blocking check. This one
pair of runs demonstrates the duplicate execution and the measured reduction;
it does not prove a worst-case bound below 150 seconds for every repository
state or machine. The final run includes the decision, design, and this
experiment document; it passed all 13 blocking checks. The full verifier
remains the source of the final verdict.
