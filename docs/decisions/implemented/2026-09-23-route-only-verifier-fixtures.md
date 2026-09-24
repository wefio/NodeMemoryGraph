# Route-only verifier tests omit unrelated shared checks

[中文](2026-09-23-route-only-verifier-fixtures.zh-CN.md)

**Status:** implemented
**Approved:** auto
**Relates to:** [Bound agent verification as one run](2026-09-23-verification-whole-run-deadline.md)

## Problem

Four narrow verifier tests assert only route-test failures or their TAP evidence. Their fixture also ran seven successful shared npm checks before reaching the asserted failure, spending time on processes irrelevant to those assertions.

## Decision

Those fixture cases use the existing `verify.sharedChecks: none` declaration. They retain the real verifier CLI, Git change discovery, Node route test, receipt, and output assertions. A separate default narrow test continues to assert that all seven shared checks ran, and the full-mode test continues to assert the full declared blocking set.

The resource selection is local to these test fixtures. It does not change any repository route or the product verifier's default behavior.

## Alternatives considered

- Keep every shared check in each route-failure test. It repeats seven child processes without exercising a distinct shared-check assertion.
- Replace the CLI with an in-process mock. This would lose the route-test execution and evidence boundary that the tests protect.
- Drop shared checks from every narrow test. This would remove direct coverage of the default shared-check floor.

## Consequences

All 28 verifier tests passed before and after the change. The targeted file took 32.672 seconds before and 22.244 seconds after in one local pair. The four affected cases together fell from about 17.55 to 5.53 seconds; the whole-file difference remains subject to machine load. See the [resource trial](../../experiments/verification/product-file-partitions-2026-09-23.md#resource-boundary-trial).

If any route-only case starts asserting shared-check execution, remove its opt-out. Revert the fixture change if the complete blocking verifier route fails or its default narrow representative stops proving shared checks.
