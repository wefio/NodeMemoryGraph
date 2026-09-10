# Narrow per-domain verification: lightweight checks compose up to the full gate

**Status:** implemented  
**Approved:** unrecorded
Date: 2026-09-07
Branch: pr/rcp-narrow-verify

Governing meta-rule: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) — this changes a standing verification convention (RCP/agent-verify route semantics), so it is recorded as a governed decision.

中文版: [2026-09-07-narrow-route-verification.zh-CN.md](2026-09-07-narrow-route-verification.zh-CN.md)

## Problem

RCP's job is to guard the gate: independently verify a change and bind evidence
into an immutable receipt. That gate must not *block normal development*.
Today almost every code change that hits a core or adapter route runs the whole
`test:product` suite plus `build`, because routes declare their verification as
a few whole-repo npm scripts:

```yaml
# pi-adapter / claude-adapter / workbuddy-adapter / core-*
verify:
  blocking: [check, test:product, build]
```

`test:product` runs every product test directory regardless of the change. The
cost is paid even for a one-line change in a bounded adapter domain. Meanwhile
the identical-class `dsh-adapter` route already declares only `[check]` — the
route declarations are internally inconsistent, and there is no concept of a
route's *own narrow verification* being used for local/agent checks.

The repo already has the narrow primitive available: every route declares
`tests: [tests/.../**]` globs, and `node --test <globs>` runs exactly those.
The coarse scripts are compositions of such tool invocations, so "lightweight"
was always available in the tools themselves; what was missing was (a) routes
declaring their own bounded verification instead of whole-suite scripts, and
(b) a coverage rule that says when narrowing is safe.

## Decision

Verification is a **composition of lightweight primitives over one vocabulary**:
running the full gate for a change is just running all the narrow pieces that
change needs. Two levels only:

- **Narrow** — a change is cleanly owned by one route's bounded domain
  (its `tests` globs) and touches no cross-cutting file: run that route's own
  tests (`node --test <route.tests>`) plus the always-run shared invariants.
- **Full** — any changed file is shared/cross-cutting (no single clean owner,
  or under a base like `src/core`, `src/lab`, `src/integration`, `src/rcp`,
  `tests/`, `package.json`, `.github`, `scripts/`, `tools/`): run the declared
  whole blocking set (`test:product` etc.). Safety first — never guess a narrow
  scope for a file whose blast radius we cannot bound.

Always-run shared invariants (tsc via `check`, `docs:check`, `format:check`,
`lint`, `package:check`) stay whole for every change.

Rationale for two levels only: medium/wide tiers add judgement with no safety
gain. Either a file's owner is unambiguous (narrow) or it is not (full). "When
in doubt, run full" is the entire safety rule.

## Consequences

- Route declarations stay the single source of per-domain verification: the
  owning route's own `tests` are the narrow set. Narrowing is exposed as the
  opt-in `agent:verify --narrow` fast path; the default authoritative gate is
  unchanged until the coverage rule is trusted. Aligning the adapter-leaf
  routes' default blocking (which today over-run `test:product` while their
  peer `dsh-adapter` runs only `check`) is the follow-up once narrow is adopted.
- A dev/agent fast path (`agent:verify --narrow`/by-paths) composes the always-run
  shared checks with each touched route's own tests; the result is exactly the
  set the authoritative gate would run for a fully-owned change. This makes
  "lightweight composed = full RCP" true for localizable changes, and leaves the
  full gate authoritative when any file is shared.
- No new executor and no primitive registry: the underlying tools (`node --test`,
  `eslint`, `prettier`, `tsc`) already accept the narrow arguments. We add route
  granularity and a coverage rule, not machinery.

## Alternatives considered

- **A primitive registry** (decompose coarse scripts into atomic checks with
  `scopeable`/`fix` metadata). Rejected as unnecessary machinery: the tools the
  scripts wrap are already individually runnable on file subsets. The genuine
  gap was route granularity + a coverage rule, not a new executor.
- **Per-route npm test scripts.** Rejected: it multiplies scripts to keep in
  sync; `node --test <route.tests>` from the route declaration is one source of
  truth.
- **Three-tier narrow/medium/full.** Rejected: medium has no safety rationale;
  two levels suffice and are easier to reason about.

## Evidence

- `tests/tools/narrow-verify.test.ts` — coverage classification: clean single
  owner → narrow; shared/cross-cutting path → full; unknown owner → full.
