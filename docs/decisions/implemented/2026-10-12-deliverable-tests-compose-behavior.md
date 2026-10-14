# Compose behavior on existing test objects

[中文](2026-10-12-deliverable-tests-compose-behavior.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

The Task Board deliverable and retention tests share claiming an entry and
submitting its artifact. Their initial scenarios differ: retention exercises
an entry before its historical expiry, then prunes at a later time. A factory
that always creates fresh work or reads its own clock does not express that
shared behavior on an existing object.

Node-relation regressions also share adjacent-pair writes on existing nodes.
Their path and cycle intent is worth naming across consumers; preparation
factories and a DAG-only graph abstraction do not preserve that intent.

## Decision

`tests/support/task-board-behavior.ts` exports the ordinary typed function
`claimAndDeliver`. The caller supplies an existing entry reference (`taskId`
and `id`), the acting identity, digest, lease duration, and `now`. The function
claims that reference, delivers it at the same supplied time, and returns the
actual delivery snapshot. It does not create an entry or infer a last result.

Scenario construction stays local to the two consumers. Deliverable tests
choose the current time; retention tests supply their historical live time.
Clock injection covers the two composed actions, not the entire scenario:
entry creation and finalization still use the product API's own clock.

The two writes are not an atomic transaction. Exceptions propagate unchanged;
if delivery fails after claiming succeeds, the claim remains observable. The
function contains no assertions or precondition filters. This is a choice for
this fragment, not a general ban on operators containing checks. Tests needing
an observation between the two actions, or a standalone rejected action, call
the store API directly.

Original assertions, expected rejections, and literal test declarations remain
at their call sites. Existing-node paths use `linkNodePath` from
`tests/support/node-graph-behavior.ts`, an ordinary function with a narrow typed
relation-writing capability. The reviewed basic paths share it; metadata writes,
evidence-merge checks, standalone edges and intermediate observations remain
explicit. The owning boundary is
[the test-runtime design](../../design/ci-cd-and-quality.md#41-行为片段与资源-fixture).

## Alternatives considered

- Keep file-local preparation factories. Replaced for the shared fragment:
  two real consumers need behavior independent of creation and clock choice.
- Read the clock inside the shared function. Rejected: historical retention
  scenarios require the caller's time for both actions.
- Wrap every individual API call. Rejected: it adds indirection without naming
  a repeated multi-step behavior. Distinct later actions stay explicit.
- Combine the whole claim/deliver/judge lifecycle. Rejected: tests need to
  observe or reject actions at intermediate states.
- Add rollback or a transaction wrapper. Rejected: it would change the failure
  semantics rather than compose the existing APIs.
- Add a DSL, generator, or case-table declarations. Deferred: they do not follow
  from one shared fragment, and RTM discovery still requires literal names.
- Sort or deduplicate path endpoints, automatically close paths, or share a
  default DAG restriction with memory chains. Rejected: endpoint order, repeated
  writes and node-relation cycles are part of the consumers' intended behavior.
- Replace the original assertions with a generic verdict. Rejected: reuse is
  not permission to redefine existing behavioral expectations.

## Consequences

The shared fragment has an explicit object reference and time boundary; it can
be repeated on the same entry after other actions. Its contract tests use
isolated in-memory stores and inspect clocks, reuse, conflict rejection, and
partial failure. The two original file-backed lifecycles remain unchanged.
There is no product API, dependency, verification-route, or acceptance-standard
change. Explicit inputs and helper tests add maintenance cost; this decision
makes no line-count or performance claim.

The lease-boundary trial uses the same function without extending its interface.
Named scenarios observe fencing before delivery, distinguish a live heartbeat
from an expired self-claim, and verify that takeover changes artifact roles
rather than permanently excluding the old actor. No original test is retired:
release-driven and expiry-driven attempts are different contexts, not proven
duplicates merely because their final fields agree.

The [second pilot record](../../experiments/verification/behavior-composition-and-combinatorial-testing-2026-10-12.md#第二轮试点结果)
and [boundary trial](../../experiments/verification/behavior-composition-and-combinatorial-testing-2026-10-12.md#第三轮边界组合结果)
own the measured comparisons, targeted runs, and negative controls. These
establish only the tested slices, not complete detection or correctness. The
[existing-node path extraction](../../experiments/verification/behavior-composition-and-combinatorial-testing-2026-10-12.md#已有节点路径实施结果2026-10-13)
owns its preservation comparison, contract runs and targeted faults. The path
function is retained for these consumers; this closes the selected block rather
than opening an automatic series of further pilots.

## Deferred

Parameter-covering generators, bounded sequence exploration, all-action clock
injection, and wider migration are outside this change, not an automatic next
trial. Split a fragment when
its consumers need an internal observation; do not hide that observation or
filter the intended rejection to keep it reusable.
