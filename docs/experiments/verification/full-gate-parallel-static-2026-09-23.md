# Bounded parallel static checks — 2026-09-23

## Protocol

The full Agent plan already listed atomic checks and deduplicated identical
commands. This experiment keeps build and package checks as serial barriers,
runs adjacent approved static checks with at most three asynchronous npm
processes, then runs `test:product` after the static group. Each check keeps
its own result and the whole run keeps one 150-second deadline. A scheduler
test checks parallel execution, barriers, declaration-order evidence, and
failure attribution; a real npm test checks asynchronous exit attribution.

Run `rtk npm run agent:verify -- --full` on Windows with Node v24.19.0.
The serial comparison is the last run reported in
[the atomic-check experiment](full-gate-atomic-checks-2026-09-23.md).

## Observation

| Plan | End to end | Product tests | Other checks and overhead | Blocking result |
| --- | ---: | ---: | ---: | --- |
| Serial atomic checks | 100.0 s | 72.2 s | 27.8 s | passed |
| Bounded parallel static checks | 96.0 s | 75.2 s | 20.8 s | passed |

The static and scheduling portion fell by about seven seconds while product
tests varied by about three seconds. A second parallel full run took 104.5 s,
including 84.2 s of product tests and about 20.3 s of other work; all 13
blocking checks passed. Parallel `check` and `lint` individually took longer
than in the serial run because processes competed for CPU. These runs support
the static-phase reduction but do not establish a stable end-to-end speedup or
a worst-case bound. The first parallel run passed 1,534 product tests;
the second passed 1,535. Both passed all 13 blocking checks;
research and chaos checks remained advisory and were not run. RCP and narrow
verification paths were not changed by this experiment.
