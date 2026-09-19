# The integration layer gets routes, so editing it runs checks

[中文](2026-09-19-route-the-integration-layer.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Decline the shared checks when a route owns its own](2026-09-16-route-declines-shared-checks.md)

## Problem

`src/integration` is declared in the `memory-runtime` capability, but no route in
`agent-context.yaml` claims it. Every edit in that layer therefore answered
`no verification route matched: src/integration/...` - no owner documents, no
tests, no checks. The layer is not small: it owns the host-neutral Agent Surface
(candidate DTO, evidence layout, board conventions, chain labels, disclosure
budgets) and the OoO/task execution orchestration, and both halves already have
owner documents and tests.

## Decision

Declare two routes over the layer, split by owner document rather than by
directory:

- `agent-surface` - the presentation and contract boundary: `agent-surface.ts`,
  `chain-projection.ts`, `search.ts`, `search-projection.ts`, `evidence.ts`,
  `tool-contract.ts`, `config.ts`, `controller-channel.ts`,
  `reasoning-workspaces.ts`, `lab-capabilities.ts`; owner
  `docs/design/design.md`; tests the matching `tests/integration/*.test.ts`.
- `ooo-execution` - the execution orchestration: the six `ooo-*.ts` files, the
  two renames `check-ticket.ts` and `check-runner.ts`, and the five `task-*.ts`
  files; owners `docs/design/ooo-execution-bootstrap.md`,
  `docs/design/task-unit-semantics.md`, `docs/design/ooo-fusion-planning.md`;
  tests `tests/integration/ooo-*.test.ts` and
  `tests/integration/task-semantics*.test.ts`.

Both declare `verify: blocking: [check, test:product, build]` and `advisory: []`,
the same declaration `core-memory` and `pi-adapter` already use, and both keep the
default `sharedChecks`.

The two routes list their files one by one, because that is what the mechanism
supports: `matches()` in `tools/repo-context.ts` treats the first `*` in a pattern
as the start of a directory prefix, so `dir/**` and exact paths match while a
mid-name pattern such as `src/integration/ooo-*.ts` matches nothing at all. A
pattern that silently matches nothing is worse than a list, so the list is the
declaration and a test keeps it complete.

## Alternatives considered

- **One route over `src/integration/**`.** Rejected: the two halves have
  different owner documents, and one route would put two homes for one rule under
  a single owner.
- **Name the files by glob (`src/integration/ooo-*.ts`).** Rejected: it matches
  nothing under the current matcher, so the route would look declared and never
  be selected - the exact failure this change exists to remove.
- **Fold the layer into `core-memory`.** Rejected: `core-memory` owns
  `src/core/**`, and a route is a claim about who owns a path, not a catch-all.
- **Have the routes point at `evals/ooo-execution/**` as well.** Rejected: the
  eval drivers are the measurement surface, and a narrow verification must not
  spend paid model calls.

## Consequences

An edit under `src/integration` now routes: `agent:context` names the owning route
and its owner documents, and `agent:verify` runs that route's blocking checks
instead of reporting that nothing matched. The layer's `desiredRevision` changes,
so the next verification run is required before routing reads clean again.

Because the routes list files, a new file in the layer would be claimed by nobody
and nothing would complain. `tests/tools/repo-context.test.ts` therefore asserts that
the union of the routes' paths, together with a list of knowingly unrouted files, is
exactly the directory listing - a new file fails that test until it is claimed, and
that list is empty today.

The four retrieval-index enrichment files (`leaf-summarizer.ts`,
`node-summarizer.ts`, `summary-drain.ts`, `openai-completion.ts`) turned out to be a
third part of the layer rather than part of either half - an external LLM writes
index text that the store then persists - so they have their own `retrieval-enrichment`
route, owned by `docs/design/design.md` and
`docs/design/tiered-disclosure-design.md`.
