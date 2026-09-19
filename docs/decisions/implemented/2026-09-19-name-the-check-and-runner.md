# Name the check identity and the check runner by what they are

[中文](2026-09-19-name-the-check-and-runner.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [The integration layer gets routes](2026-09-19-route-the-integration-layer.md)

## Problem

Two files under `src/integration` carried an `ooo-` prefix that told a reader
nothing about which was which: `ooo-check.ts` is 38 lines holding one identity
type (`CheckTicket`, the host-issued identity of an external check), while
`ooo-verifier.ts` is the thing that actually runs a check and returns a result.
Neither name says identity or runner.

## Decision

Rename exactly those two: `ooo-check.ts` becomes `check-ticket.ts` and
`ooo-verifier.ts` becomes `check-runner.ts`. The other six `ooo-*.ts` files keep
their prefix and the layer stays flat.

## Alternatives considered

- **Rename the subsystem away from `ooo`.** Rejected: the term is the project's
  own name for the scheduling model it implements, and it is load-bearing in more
  than a hundred documents - `docs/design/ooo-execution-bootstrap.md`, the decision
  records, and the frozen run archives under `docs/experiments/execution/archive/`.
  Renaming the code would leave every historical record citing paths that no longer
  exist, and those archives are evidence rather than drafts.
- **Group the subsystem into `src/integration/ooo/`, so the name is said once.**
  Rejected for now: it is a structural move across roughly eighty import edges, and
  the two routes now make the layer's parts visible without moving a file.
- **Rename nothing.** Rejected: those two names are the pair a reader has to decode
  by opening both files.

## Consequences

Six files updated, no documentation reference to repair (there were none) and no
public surface changed - neither name appeared in a CLI command or a tool name.
`docs/experiments/ooo-admission-2026-09-08.md` still names the old path in prose;
it is a dated measurement record and is left as it was written.

The layer's routes list files rather than patterns, so the renames had to reach
their declarations in `agent-context.yaml` in the same change; the test added with
those routes fails until every file under `src/integration` is either claimed or
named as a known gap.
