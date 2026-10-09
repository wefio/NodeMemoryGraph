# Full-gate budget margin — 2026-10-09

## Scope and prior evidence

The original nine-path clean verification at `eb093bf6a492d81d782d2a31ef1f26e80893fcf5`
exceeded the unchanged 150,000 ms overall deadline twice. Contract discovery
returns no authored RCP contract for this scope: it uses the direct full plan,
not the serial RCP provider. The previous [atomic](full-gate-atomic-checks-2026-09-23.md)
and [parallel static](full-gate-parallel-static-2026-09-23.md) optimizations remain
in place. New checks were not included in the approved parallel set.

Fixed partitions are not reintroduced: the
[partition probe](product-file-partitions-2026-09-23.md#limits-and-next-decision)
records the failed replication and removal of that candidate.

## Product-stage comparison

Same original source, Node v24.19.0, Windows, same 1,675-test product inventory.
The ordinary four-worker command passed in 101.625 seconds; changing only Node's
file-worker limit to eight passed in 58.799 seconds. Node reported 100.657 and
58.704 seconds respectively. The four-worker run used the npm entry; the
eight-worker probe invoked Node directly, so outer durations include different
bootstrap overhead. Both had zero failures, cancelled, skipped or todo
cases. No tests, compiler scope, assertions or cleanup were removed. These are
serial stage samples on a live workstation, not an isolated CPU benchmark or a
whole-run performance guarantee.

## Candidate

- Keep the same full verification membership and 150,000 ms watchdog/deadline.
- Add read-only `check:tests`, `mutation:anchors` and `check:policy-words` to the
  existing adjacent static batches (at most three asynchronous checks).
- Use eight Node product-test file workers, with exactly the existing globs.
  Coverage remains at two workers with the same file inventory.
- Keep build/package/product barriers, individual failure attribution and
  declaration-order results. RCP/narrow execution policy is unchanged.
- Focused contracts assert the exact approved set, bounded execution, no writer
  overlap, complete results/failures, and product/coverage scope parity.

## Full-run evidence

The full candidate passed all 16 blocking checks and all 1,678 product tests
(the original 1,675 plus three new contracts). The outer npm command, watchdog,
worker and receipt completed in **129.072 seconds**, leaving 20.928 seconds of
the unchanged 150-second deadline. The worker receipt ran from
2026-10-09T15:25:25.214Z to 15:27:32.662Z; its run ID is
`a30e1e55-b00a-4de3-8ba4-33bdfc888f2c`.

This was a dirty pre-commit run on base `eb093bf6`, covering the original nine
paths and eight owned implementation/documentation paths, not a clean receipt.
Product took 75.731 seconds in this run, rather than the standalone 58.799;
`check:tests`, lint and formatting took 16.574, 14.630 and 14.539 seconds under
static contention. Individual durations overlap and must not be summed as wall
time. The paired stage result does not isolate how much each optimization
contributed to the whole candidate. Research/chaos remained advisory and skipped
unless explicitly requested, exactly as in the original command.

The separate full mutation sweep caught 110/110 mutants across 22/22 targets,
restored every target byte-identically and exited zero; no mutation lock remained.
The [machine-readable observation](full-gate-margin-2026-10-09.json) retains
phase durations, code hashes and the mutation result. Post-commit clean evidence belongs to its exact
HEAD and scope; it is reported separately in the delivery PR, alongside forge
CI observations. This dirty-run report must not substitute for those receipts.

## Limits

Timing applies to this machine/workload; it is not a worst-case guarantee under
arbitrary load or on other hardware. No cache-based skipping, test partitioning,
impact subset, reduced assertion, widened deadline or weakened gate is used.
Official benchmark/provider/cloud workloads are outside this experiment.
