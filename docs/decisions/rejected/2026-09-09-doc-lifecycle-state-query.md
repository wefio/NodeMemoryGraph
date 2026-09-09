# Query the derived state of a decision record

[中文](2026-09-09-doc-lifecycle-state-query.zh-CN.md)

**Status:** rejected

## Problem

A decision record's declared state is the directory it lives in — `proposed/`,
`implemented/`, `rejected/`, `archived/` — and `docs:check` keeps that
declaration honest: `**Status:**` must equal the directory, the header field set
is closed, and local links must resolve. Nothing answers the *observed*
question: a `proposed/` record whose acceptance criteria are already satisfied,
or an `implemented/` record whose criteria no longer hold. Nineteen of forty
design documents once carried free-form statuses, and that drift stayed invisible
until someone read every one of them.

## Proposal

Derive decision state on read, and expose it as a command:

```text
$ npm run docs:state
  declared      observed              record
  proposed      ready-to-accept       2026-09-06-board-governance-addressing
  implemented   drifted (1/7)         2026-08-08-…
```

The observed state is a function of criteria and receipts: a decision's
`## Verification` carries a machine-readable block (`id`, then `check` | `grep` |
`documented-only`), `docs:check` validates the block's shape, and the command
reads the block plus `.rcp` receipts to report the gap between declared and
observed. A companion `nmg docs promote <slug>` would perform the mechanical part
of an accepted transition (`git mv` plus rewriting `**Status:**`), dry-run by
default.

## Alternatives considered

**A prompt instead of a command.** One Skill sentence — read `docs/decisions/**`
and report declared versus observed — needs no code, no tests, and no CLI
surface. Rejected for the same reason as the command: nothing consumes the
answer.

**Promote automatically when the criteria pass.** Rejected outright. Acceptance
is a judgement, not a computation; a directory that means "the tests pass"
duplicates CI; and a tree that rewrites itself cannot be reproduced from a
commit. dsh verifies note classification and never moves a note; PEP, KEP, and
MADR all promote by a human decision.

**Nothing — the folder already is the state.** Chosen.

## Why rejected

The query has no consumer. `docs:check` already makes the declared state
trustworthy, so reading the folder answers "what state is it in" without a
derived layer, and the Agent that could run the command will probably not run it.
The one gap the command would surface — a `proposed/` record whose criteria are
already satisfied — has never been asked about; when it is, the reader opens the
file.

Building a reader nobody reads is the same failure as writing data nobody reads.
`WorkOrder.expectedArtifacts` was declared from the first version, read by
nothing, and deleted on 2026-09-09; the free-form `**Status:**` vocabulary was
written in nineteen documents and readable by no machine. Machine-readable data
earns its keep with exactly one reader: zero readers is dead data, one reader is
alive (`docs/glossary.yaml` and `glossary-check`), and many readers is an
integration that deserves a gate.

## Consequences

`docs/decisions/` keeps exactly one mechanism: the lifecycle directory plus the
`docs:check` invariants. There is no `docs:state`, no `nmg docs promote`, no
`verification:` block in decision records, and no shape gate for one. A
decision's criteria stay prose under `## Verification`, which is where a human
reads them.
