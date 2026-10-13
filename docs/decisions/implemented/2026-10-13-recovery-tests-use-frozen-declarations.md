# Recovery tests consume the frozen declaration

[中文](2026-10-13-recovery-tests-use-frozen-declarations.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Opaque dispatch declarations](2026-09-21-mechanism-not-policy.md#opaque-dispatch-declarations), [Runnable suites and executed checks](2026-10-13-runnable-suites-and-executed-checks.md)

## Problem

Five of the nine recovery scenarios at baseline `66238c2` fail before testing
recovery because seven artifact constructions read the removed `ticket.patch`
field. The current `BoardAdmission.claim()` returns a
`BoardTicket<FrozenPatchWork>` with the frozen work in `declaration`; the debugger
observes that declaration after reopening and its digest matches `inputDigest`.
A direct TypeScript check rejects all seven obsolete accesses, but the blocking
`check:tests` configuration does not include these standalone harnesses.

## Decision

The local artifact fixture accepts `Readonly<BoardTicket>`, requires the frozen
declaration, checks its digest against the ticket's input identity, and constructs
the same patch payload from `declaration.digest`. It does not recreate frozen work
or supply a fallback declaration. The submission fixture accepts the same ticket
type. No product ticket, schema, generation or acceptance rule changes.

All nine literal scenario names and prior observations remain. The successor
scenario also submits a deliberately wrong artifact digest and observes rejection
and no acceptance before submitting the correct artifact under the same live
claim. This negative input reaches the host, not just the fixture's assertion.

The existing blocking `check:tests` includes `evals/ooo-execution/*.test.ts`.
`tests/tools/test-groups.test.ts` compares TypeScript's actual configured root files
against runnable OoO suites selected by the coverage owner. Frozen fixture and
archived evidence files are not independent compiler roots. Imported dependencies
remain subject to normal TypeScript checking. Runtime evaluation remains on-demand;
this does not execute a live provider or benchmark during static CI.

The owning contracts are [test execution tracks](../../design/ci-cd-and-quality.md#2-执行轨道)
and [recovery observations](../../design/ooo-execution-bootstrap.md#由此得到的改进清单).

## Alternatives considered

- **Restore a `patch` alias in the product ticket.** Adds a second carrier to an
  intentionally opaque declaration contract solely for a stale test consumer.
- **Use only `inputDigest`.** Could construct an artifact without observing the
  patch adopter's required declaration. The fixture explicitly validates both.
- **Skip the failing cases or relax stale/duplicate checks.** Would remove the
  recovery obligations rather than repair their inputs.
- **Type-check every file under `evals/`.** Broadens to unrelated instruments and
  frozen inputs. The existing gate gains only the runnable OoO test roots.
- **Create another runner or operator registry.** The repair uses the current
  artifact fixture, coverage selection and compiler gate; none needs a new DSL.

## Consequences

The original runtime reproduction changes from four passes/five failures to nine
passes; the selected ten-suite set changes from 86 passes/five failures to 91
passes with no skips on Windows. The type-surface regression fails against the old
configuration and passes after the include change. Strict TypeScript and unused
checks cover the ten harnesses through the existing blocking entry.

These are local protocol and persistence observations, not a claim of distributed
exactly-once execution. Recovery closes/reopens the coordinator; the schema case
reapplies setup to a database already created by the current constructor. It does
not build a legacy database or inject an abrupt OS process crash. No Linux run,
GitHub workflow dispatch, live provider or complete benchmark is established.
