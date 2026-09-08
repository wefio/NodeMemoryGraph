# RCP lightweight verification by default (proposal)

[中文](2026-09-07-rcp-lightweight-verification-default.zh-CN.md)

**Status:** proposed
**Date:** 2026-09-07
**Relates to:** [repository-control-plane](../implemented/2026-08-29-repository-control-plane.md),
[narrow-route-verification](../implemented/2026-09-07-narrow-route-verification.md),
[repo-development](../../../skills/repo-development/SKILL.md)

## Problem

The RCP gate guards the repository and must never block normal development.
Today a change that hits a core or adapter route pays the whole declared
blocking set — most routes declare `[check, test:product, build]`, and
`test:product` runs every product test directory regardless of what changed —
while the identical-class `dsh-adapter` already declares only `[check]`. The
declarations are internally inconsistent, and no route expresses its own
*bounded* verification. #31 added the narrow path as an opt-in
(`agent:verify --narrow`), but the default authoritative gate is unchanged, so
everyday development still pays the whole suite, and the adapter-leaf routes
still over-run `test:product`.

## Proposal

Verification is a **composition of lightweight primitives over one
vocabulary**; running the full gate for a change is just running every narrow
piece that change needs. Make narrow the **default**:

1. **Narrow by default, escalate on doubt.** A change cleanly owned by exactly
   one non-shared route runs that route's own tests (`node --test
   <route.tests>`) plus the always-run shared invariants (`check`/tsc, `docs:check`,
   `format:check`, `lint`, `package:check`). Any shared / cross-cutting /
   ambiguous / unowned path escalates to the declared whole blocking set.
   "When in doubt, run full" is the whole safety rule.
2. **Shared-root list** (`src/ tests/ scripts/ tools/ .github/ package.json
   tsconfig*.json agent-context.yaml AGENTS.md`) is always full — a change
   there has unbounded blast radius and must never be guessed narrow.
3. **Align adapter-leaf routes.** `pi-adapter` / `claude-adapter` /
   `workbuddy-adapter` over-run `test:product` today; align them to their own
   bounded tests (each already declares `tests:`), matching `dsh-adapter`.
   Core/shared routes keep the whole suite.
4. **No new executor, no primitive registry.** The underlying tools already
   accept the narrow globs (`node --test <route.tests>`); narrowing needs only
   route granularity + a coverage rule, not machinery.

Default flips in `agent:verify` (and any RCP route verification), with
`--full` forcing the whole set and `--narrow` forcing narrow. The coverage
rule is a tested pure function (`tools/narrow-verify.ts`, already present from
#31).

## Alternatives considered

- **Primitive registry** (split coarse scripts into atomic checks with
  `scopeable`/`fix` metadata). Rejected: redundant — every tool a script wraps
  already runs on a file subset; the real gap was route granularity + a
  coverage rule, not a new executor.
- **Per-route npm test scripts.** Rejected: a pile of scripts to keep in sync;
  deriving `node --test <route.tests>` from the route declaration is one source
  of truth.
- **Three tiers (narrow / medium / full).** Rejected: the medium tier adds
  judgement with no safety gain; two levels reason more cleanly.
- **Keep opt-in only.** Rejected for the default: it leaves everyday
  development paying the whole suite and does not fix the adapter-leaf
  inconsistency.

## Acceptance criteria

- A one-line change confined to a leaf adapter's own domain runs only that
  route's tests + shared checks (no `test:product`), on the default path.
- A change touching any shared/cross-cutting path runs the full blocking set.
- The coverage rule's classification (single clean owner → narrow; else full)
  is covered by `tests/tools/narrow-verify.test.ts`.
- The authoritative gate for un-owned/ambiguous changes is never weaker than
  today's full set.
- Route declarations remain the single source of per-domain verification.

## Risks

- **Silent coverage loss** if a route's `tests:` glob stops covering code it
  owns. Mitigated by the safety rule: any path not cleanly owned by one route,
  or under a shared root, escalates to full — narrow only ever applies to an
  unambiguous single-owner, non-shared file.
- **Ownership drift** as files move between routes. Mitigated by the
  ambiguity/escalation default (0 or >1 owners → full) rather than guessing.
- **Adoption resistance**: default flip changes behaviour for every route
  verification. Mitigated by keeping `--full`/`--narrow` explicit and the
  shared-root escalation unchanged.
