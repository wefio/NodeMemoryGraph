# Maintenance pressure that tier rebalancing could not drain

[中文](0005-maintenance-pressure-cannot-drain.zh-CN.md)

**Status:** resolved

## Executive summary

The resident daemon repeatedly selected nodes using access counters on superseded records, while tier rebalancing consumed counters only on indexed active or disputed records. Full batches therefore scheduled more full batches without draining their trigger. Tests covered productive active backlogs, not eligibility changes. The correction aligns pressure with the work that can consume it and tests the stopping condition through the store and service interfaces.

## Summary

A read-only storage inspection during retrieval integration identified the maintenance journal, not retrieval traces, as the storage hotspot. The latest 1,000 journal rows repeatedly maintained the same four nodes: 889 local batches and 111 semantic batches. Local batches changed no memory tiers and rebuilt no leaves; semantic results reported no changed rows. That observation alone did not establish that every SQL operation was a no-op.

## Impact

At the 2026-10-11 14:13 UTC snapshot, `maintenance_runs` held 6,726,892 rows. Its table and two indexes occupied 3,107,803,136 bytes, about 95% of 3,272,433,664 database page bytes. Retrieval traces occupied 10,465,280 bytes. This is one local database observation, not a general size or latency guarantee. Repeated work added scheduling, rebalancing and journal writes; no memory loss or reference misbinding was established. The fix does not remove historical records or reclaim existing file space.

## Timeline

- The deployed service contained the mismatched pressure and consumption predicates.
- Lexical/reference integration passed its existing targeted and clean checks before this investigation.
- Read-only inspection located repeated maintenance batches and historical access balances.
- A temporary-store regression expected no due work below the eligible threshold and failed with `1 !== 0`.
- Eligible-pressure, empty-journal and resident-service regressions passed after the correction. No historical pruning was performed.

## Root cause

Global and per-node access sums counted records that `rebalanceNode` excluded. Their balances survived every rebalance. When enough such nodes filled `nodeLimit`, the service's full-batch continuation kept scheduling work; semantic maintenance also ran at its productive-batch cadence. No new user access was needed to sustain the loop. Dormant records had the same eligibility mismatch.

The prior backlog tests used active indexed records and asserted that work progressed. The direct due-node test checked only that an array was returned. Service backlog tests did not cross an eligibility transition. Type, schema, packaging and static gates could not establish that a runtime trigger was consumable or would eventually stop.

## Guardrails added

- [Store maintenance regressions](../../tests/core/store/maintenance.test.ts) cover superseded/dormant pressure, a productive active control, a stopping check, reactivation and empty checks with retained performance aggregates.
- [Service regression](../../tests/cli/service.test.ts) exercises a real file-backed backlog through RPC and event-loop slices without deleting historical memory.
- [The maintenance contract](../design/design.md) owns eligibility and journal semantics. Semantic rows are not suppressed solely on `rowsTouched`: trace-signal drainage can change durable state independently.

## Lessons

A work trigger must describe state that its worker can consume. Bounded individual batches do not bound a loop whose trigger survives each batch. Prefer a transition-and-stop regression to a reminder; preserve meaningful provenance rather than merging journals merely because they are large.
