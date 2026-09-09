# Classify designs and experiments by their own axis

[中文](2026-09-09-design-and-experiment-classification.zh-CN.md)

**Status:** implemented

## Problem

`docs/design/` had no state discipline. Nineteen of forty documents carried a
`**Status:**` line, and those nineteen used **21 distinct values**:
`诚实评估 / honest assessment`, `requirement ledger`,
`documentation convention and curated recovery index`,
`the actuator exists behind an explicit, default-off policy…`. No machine could
read a lifecycle from them, and a design marked `superseded` sat in the same
directory as the live ones with no enforced successor link.

`docs/experiments/` had the opposite problem. Thirty-eight of forty reports are
concluded, so a lifecycle axis carries no information there, while four lines of
related runs — `retrieval-quality-*` ×6, `context-*` ×6, `topology-*` ×3,
`qpp-*` ×3 — had no grouping at all.

## Decision

**A directory is the right home for a state when the states are balanced and the
transitions are frequent.** Decisions qualify (3 proposed / 16 implemented /
3 rejected / 0 archived) and keep their lifecycle directories. Designs and
experiments do not, so they carry their state on a line instead — the same rule
the decision header block already enforces.

**Designs.** The header block is the lines before the first `##` and carries a
closed set: `Status`, `Created`, `Updated`, `Authority`, `Related`, `Supersedes`,
`Superseded by`. `Status` is an enum — `draft`, `current`, `superseded` — with an
optional ` — qualifier` after the token. An absent status means `current`: the
tier is defined as current-state design, so only the exceptions have to say so.
`superseded` requires a `Superseded by` link, and the document must live in
`docs/design/archived/`; anything in that directory must be `superseded`.

**Experiments.** Every run lives in the topic directory that names the line of
inquiry it answers — `retrieval-quality/`, `retrieval/`, `context/`, `topology/`,
`qpp/`, `benchmarks/`, `store/`, `runtime/`. `benchmarks/` groups the dataset
runs (LongMemEval, LoCoMo, BEAM, HaluMem) and keeps the dataset name as the
filename prefix, because that prefix names the dataset, not the directory.
Reports are named `<slug>-<YYYY-MM-DD>.md` and the slug drops the topic prefix
when it repeats the directory name; only `benchmark-results.md` stays at the top
level, because it spans topics. The topic list and the naming rule live in
`docs/experiments/README.md`.

The rule lives in `skills/doc-maintenance/SKILL.md`; the gate is
`checkDesignHeader` in `scripts/verify-docs.mts`, with tests in
`tests/docs/verify-docs.test.ts`.

## Alternatives considered

**Full lifecycle directories for designs** (`docs/design/{draft,current,archived}/`).
The strongest guarantee — the path *is* the state — and the option this decision
rejected. It costs 40 `git mv` operations and roughly 278 inbound link sites to
buy about what a checked status line already buys, and it would leave ~37
documents in one directory. When one state dominates, a directory is a container,
not a classifier.

**A lifecycle axis for experiments.** Experiments are 38 concluded / 2 open; a
state directory would hold almost every file.

**Topic directories only for lines of three or more runs.** The first cut of
this change used that threshold. It left 21 one-off runs in an unexplained
top-level pile — a classification that is visibly partial, and therefore a
classification a reader cannot trust to be complete.

**YAML front matter for designs.** The decision header block rejected it for
decisions; the same reasons apply, and design prose would gain a second syntax
for facts it already states.

**Prune `Created:` and `Updated:` as git duplicates.** They restate git's first-
and last-commit dates, so the one-home rule argues for deleting them across 20
documents. Left in place: they are not the drift this decision fixes, and the
churn is not justified yet. Recorded under Deferred.

**Reject bare `Word:` header lines.** The same deferred gap as the decision
header block, for the same reason: an uncommitted decision still carries them.

## Deferred

`Created:` and `Updated:` still restate git's first- and last-commit dates.
Revisit if they drift; today they are stable and cheap.

Bare `Word:` header lines are still treated as prose, in both decisions and
designs.

## Consequences

`docs/design/` has one archived document
(`archived/file-content-source-design.md`) and no free-form status values.
Eighteen status sentences became enum tokens with their caveats kept as
qualifiers, so no information was lost. Six fields outside the closed set
(`Date`, `Owner`, `Commits`, `Purpose`, `Normative source`,
`Implementation recovery`) became `Updated:` or prose. `docs/experiments/` has eight topic directories holding every run, and its
filename gate now checks the basename, so a report inside a topic directory is
still date-checked. `benchmark-results.md` remains the only top-level record,
because it spans topics.
