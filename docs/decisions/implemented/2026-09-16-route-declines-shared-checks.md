# A route may decline the always-run shared checks

**Status:** implemented  
**Approved:** explicit
Date: 2026-09-16
Branch: feat/ooo-run-namespace

Governing meta-rule: [self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) — this rule
change is itself recorded as a governed decision (decision + owner + alternatives) under it.

中文版: [2026-09-16-route-declines-shared-checks.zh-CN.md](2026-09-16-route-declines-shared-checks.zh-CN.md)

## Problem

The narrow gate (`agent:verify`, [CI/RCP §7.14](../../design/ci-cd-and-quality.md#714-轻量验证默认narrow-gate))
runs the always-run shared checks (`NARROW_SHARED_CHECKS`: `check`, `docs:check`, `format:check`,
`glossary:check`, `lint`, `package:check`, `rtm:check`) for **every** narrow change, whatever the
changed surface is. For a change that is cleanly owned by one route and touches no code - a
`.gitignore` line - none of those checks can fail because of it: they read `tsconfig`, the ESLint
config, `.prettierignore`, the docs, the terminology index, the contracts and the package closure,
and none of them reads `.gitignore`. The run is therefore not evidence, it is overhead, and it
reports `passed` for checks that could not have gone any other way.

Before this decision the only ways to express "this surface needs no such checks" were to declare a
route with an empty blocking set (which does not remove the shared checks - measured: the plan still
listed all seven) or to leave the path unrouted (which `agent:verify` refuses, fail-closed). Neither
says the actual fact.

## Decision

**A route may declare the always-run shared checks not applicable to its own surface**, through
`verify.sharedChecks: "always" | "none"` in `agent-context.yaml` (default `"always"`, i.e. today's
behaviour for every route that does not say otherwise).

The declaration is honoured only where it is meaningful, and every limit is mechanical:

- **Narrow only.** It is read while the narrow plan is built; a shared/cross-cutting scope
  (`src/`, `tests/`, `scripts/`, `tools/`, `.github/`, `package.json`, `package-lock.json`,
  `tsconfig.json`, `tsconfig.build.json`, `agent-context.yaml`, `AGENTS.md`) still escalates to the
  route's declared blocking set, so the declaration cannot buy a floor-free path for a code surface.
- **Singly owned only.** The plan narrows only when every changed scope has exactly one owning route;
  a cross-route or ambiguous change escalates and runs the full set regardless of any declaration.
- **Never nothing.** `sharedChecks: "none"` with an empty `tests:` array is refused when the config is
  loaded, because the plan would then execute zero checks. A verification tool must never report
  "nothing ran" as a pass, and that is the one outcome this could otherwise produce.
- **An unknown value fails closed.** Anything other than `"always"`/`"none"` is refused at config
  load rather than read as one of them.
- **Recorded, not inferred.** The receipt's `gate.reason` names the declaration, so a reader does not
  have to count checks in the plan to discover that the floor was declined.
- **One home for the check list.** `agent-verify` builds its check list from the plan
  (`narrowPlan.shared`) instead of re-deriving the floor from the constant.

The first route to declare it is `repository-tooling`, whose only non-shared path is `.gitignore`;
its own tests (`tests/tools/**`) still run, and they are where the assertion that reads ignore rules
lives (`tests/tools/complexity-gate-base.test.ts`: the complexity gate's probe scratch must stay
invisible to `git status`, or the gate measures its own litter).

## Alternatives considered

1. **Keep running the shared checks everywhere** (the status quo). Rejected: it makes the plan
   uniform at the cost of executing checks that cannot fail for the change, which is exactly the
   ceremony that erodes trust in a green gate. It also hides the real question - "what can fail for
   this change?" - behind a fixed list.
2. **Make every check declare its inputs and route the plan by dependency** (a dependency map).
   Correct in principle and much larger: it changes what a route means for every route, needs a
   mapping from change kinds to consumers, and its own evidence would be a research project. Kept as
   the direction to take if the per-route declaration proves too coarse.
3. **Honour an empty blocking set as "no checks"** (drop the floor when `blocking: []`). Rejected:
   it would let a route go unchecked by accident (an empty list is easy to write and means "nothing
   to run" rather than "the shared checks do not apply"), and it was measured not to work at all -
   the floor is injected independently of `blocking`.
4. **Leave `.gitignore` unrouted.** Rejected: `agent:verify` refuses an unmatched scope rather than
   guessing, so the effect is a red gate for every harmless ignore edit, and the workaround
   (`-- <owned-path>`) silently excludes the change from the plan.
5. **Per-path declarations** (the flag names the paths it applies to). Rejected for now as
   premature: today it would have exactly one entry, and the route-level form keeps the declaration
   where the route's tests and owners already are. Revisit if a route needs it for one of several
   surfaces.

## Consequences

- The capability is a declaration, not an inference: nothing becomes narrower by accident, and the
  green result of a narrowed run says less, which `gate.mode`/`fullGateRun`/`gate.reason` record.
- **Residual risk, stated rather than hidden:** the declaration is route-level, so adding a new
  non-shared path to `repository-tooling` would silently extend it to that path. The mechanical
  guard is the one that prevents the worst outcome (zero checks); coverage of the new path is not
  checked. If a second route needs the declaration, the criterion should be re-examined then.
- `.gitignore` keeps one meaningful check - the consumer assertion in the route's own tests - and
  the ignore semantics themselves remain git's business, which no gate should duplicate.
