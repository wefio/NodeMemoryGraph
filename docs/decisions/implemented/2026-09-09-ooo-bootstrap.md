# Bootstrap restricted OoO through real development

[中文](2026-09-09-ooo-bootstrap.zh-CN.md)

**Status:** implemented
**Approved:** explicit

Implementation evidence: the seed and the cycle live in `src/integration/ooo-{board,candidate,cycle,mutation,round-log,verifier}.ts` with their drivers and product cases, and the bootstrap cycle's records are in `docs/experiments/execution/`.

## Problem

A snapshot demonstration does not expose the requirements of developing with OoO.
The user prefers bootstrapping to reveal real needs and failures. Building a full
platform before using it would defer that feedback and encourage speculative
features. The [probe evidence](../../experiments/ooo-admission-2026-09-08.md)
remains evidence of a restricted experiment, not production readiness.

## Decision

Use a minimal conventional seed, then develop the next version through the
previous frozen version. The [draft design](../../design/ooo-execution-bootstrap.md)
owns the task contracts, first development cycle, phase gates and rollback rules.
The seed enables bounded patch artifacts, real external check events and separate
candidate verification; it does not require completing every production surface.

The bootstrap-first direction reflects the user's preference. This record remains
proposed because its concrete execution and promotion contracts need implementation
and validation; it does not introduce a repository-wide workflow rule or enable
normal-session scheduling.

## Alternatives considered

- Complete the production scheduler first: delays real feedback and increases the
  chance of building unused capabilities.
- Keep arithmetic and heading probes: useful for admission regressions, insufficient
  for learning development-task requirements.
- Let the candidate schedule and approve its own changes: creates circular evidence
  and makes recovery depend on the version under test.
- Continue only ordinary sequential development: retain this as explicit recovery,
  not the preferred path once the minimal seed works.

## Consequences

The criteria this record set are met; the evidence line at the top of this file names what implements them. Anything still owed stays written down in the design or pilot document this record links to.

Apply the draft's S0–S4 gates. In particular, a real external wait must permit an
independent development task to run; a useful OoO change must be independently
accepted and used by the next cycle. Artificial delays, model self-approval and
manual task ordering are not substitutes. Production and speedup claims require
separate evidence beyond a successful bootstrap cycle.

## Risks

The seed can expand into a platform unless bounded by the first real task.
A fixed dependency plan may expose little useful overlap; report sequential
fallback rather than invent waiting. Worktrees do not isolate arbitrary code.
Tests and review provide bounded assurance, not a universal correctness oracle.
Human recovery or promotion is permitted but must be visible in the evidence.
