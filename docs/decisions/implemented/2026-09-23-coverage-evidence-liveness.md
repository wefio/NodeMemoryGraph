# Require nonzero evidence from the product coverage run

[中文](2026-09-23-coverage-evidence-liveness.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

A successful test process can leave c8 with no covered source in its configured
include set. That run produces a 0% report even though all tests passed, so the
coverage track needs an explicit evidence check.

## Decision

The existing `test:coverage` command uses c8's coverage check with a 0.01% line
floor. This is a liveness floor for the existing included source set, not a
quality target. It makes a passing full coverage track require at least some
measured covered lines. The test list and concurrency remain the same.

## Alternatives considered

- Treat test exit status alone as coverage evidence. Rejected because c8 can
  produce a zero-coverage report after a passing out-of-scope test subset.
- Set a high total or per-file threshold now. Rejected because that is a
  separate coverage-quality policy requiring a full baseline and ownership.
- Write a custom report validator. Rejected while c8's built-in check covers
  the observed empty-evidence failure.

## Consequences

- A zero-coverage run fails instead of silently producing an apparently valid
  coverage artifact.
- This floor does not certify that every expected file was exercised; test
  inventory and a future coverage policy remain separate decisions.
- Remove this floor if c8's built-in check produces a false pass or false fail
  for this configured source set, and replace it with an evidenced check.
