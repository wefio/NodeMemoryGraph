# Bounded parallel static checks — 2026-09-23

[English](full-gate-parallel-static-2026-09-23.md) | [简体中文](full-gate-parallel-static-2026-09-23.zh-CN.md) · [Terms](full-gate-parallel-static-2026-09-23.terms.yaml)

Evidence boundary (2026-10-17 documentation review): all timings, test counts,
check outcomes and tool/route descriptions below are historical observations on
their recorded inputs. They are not fresh checks of this documentation worktree.
No suite, gate, coverage run or benchmark was executed to produce this translation
review; missing run identity or snapshot details remain explicit uncertainties.

## Protocol

The full Agent plan already listed atomic checks and deduplicated identical
commands. This experiment keeps build and package checks as serial barriers,
runs adjacent approved static checks with at most three asynchronous npm
processes, then runs `test:product` after the static group. Each check keeps
its own result and the whole run keeps one 150-second deadline. A scheduler
test checks parallel execution, barriers, declaration-order evidence, and
failure attribution; a real npm test checks asynchronous exit attribution.

Run `rtk npm run agent:verify -- --full` on Windows with Node v24.19.0.
The table below labels its serial baseline as 100.0 seconds, whereas
[the atomic-check experiment](full-gate-atomic-checks-2026-09-23.md) ends with
107.4 seconds. This record does not identify the native run or input snapshot
for the 100.0-second row; its earlier attribution to that last run is unresolved.

## Observation

| Plan | End to end | Product tests | Other checks and overhead | Blocking result |
| --- | ---: | ---: | ---: | --- |
| Serial atomic checks | 100.0 s | 72.2 s | 27.8 s | passed |
| Bounded parallel static checks | 96.0 s | 75.2 s | 20.8 s | passed |

The displayed non-product portion falls by 7.0 seconds (27.8→20.8), while
product tests rise by 3.0 seconds (72.2→75.2), giving a 4.0-second end-to-end
drop (100.0→96.0). The seven-second value is not an end-to-end speedup. A second parallel full run took 104.5 s,
including 84.2 s of product tests and about 20.3 s of other work; all 13
blocking checks passed. Parallel `check` and `lint` individually took longer
than in the serial run, consistent with CPU competition but not an isolated
measurement of its contribution. These runs support
the static-phase reduction but do not establish a stable end-to-end speedup or
a worst-case bound. The first parallel run passed 1,534 product tests;
the second passed 1,535. Both passed all 13 blocking checks;
research and chaos checks remained advisory and were not run. RCP and narrow
verification paths were not changed by this experiment. The differing
1,533/1,534/1,535 counts across these records must not be assumed to describe
an identical test inventory; per-run input snapshots are not pinned here.
