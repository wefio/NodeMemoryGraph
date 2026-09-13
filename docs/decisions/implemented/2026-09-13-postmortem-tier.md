# A post-mortem tier for escaped failures

[中文](2026-09-13-postmortem-tier.zh-CN.md)

**Status:** implemented  
**Approved:** explicit

## Problem

NMG documents design, decisions, measurements, completion, and unresolved work.
It has no home for a failure that reached a place it should not have, so the part
that costs the most to rediscover — why the safety nets missed it — has nowhere to
land.

Two escaped failures are currently recorded by accident:

- A family migration overwrote a batch of files with `git show HEAD:<path>`
  versions that predated an earlier migration, restored them from a wrong backup
  path, and re-applied only the later migration. The earlier migration silently
  disappeared from the four files present in both batches, and no check covers
  `evals/`. It was found by a throwaway duplication measurement (`90178712`).
- A deleted `omni-venv` left `benchmark:omni` running with whatever `python` was
  on `PATH` — wrong numbers rather than an error — while a second script threw
  loudly. That one landed in the `## Problem` section of
  [the venv decision](2026-09-11-benchmark-venv-consolidation.md), because that
  section is where a decision motivates its choice.

Both were found by accident, and no rule was missing the day they happened: the
gap is that a failure story has no owner, and each of the existing surfaces makes
it unwelcome. A decision record's subject is a choice, not an incident, and its
format has no slot for a timeline or a root cause. `docs/experiments/` holds
forward-looking measurements that become normative only when a decision accepts
them. `docs/design/improvement-areas.md` lists gaps that have no failure behind
them yet. And the
[slop checklist](../../../skills/doc-maintenance/SKILL.md#one-home-per-fact-and-the-slop-checklist)
rightly bans narrated history from design prose. The only remaining home is a
commit body, which is reachable only by someone who already knows the commit.

## Decision

Add `docs/postmortem/` as the repository's only home for failure narrative, and
gate its structure.

- **Triage rule.** Write one when the mechanism is subtle, the escape is systemic
  (a gap in tests, tooling, checks, or conventions), and rediscovering it would be
  expensive. An ordinary bug fix stays in its commit. This rule lives in the
  [tier index](../../postmortem/README.md#when-to-write-one).
- **Required sections.** Every record carries a non-empty `Executive summary`,
  `Summary`, `Impact`, `Timeline`, `Root cause`, `Guardrails added`, and
  `Lessons`. They are the questions the writer must answer, including what the
  failure could _not_ do. A section with no answer says so in words.
- **Header.** The header block is closed and carries `**Status:** open | resolved`
  — `resolved` means the guardrails exist and are linked, `open` means the failure
  is understood and not yet caught.
- **Numbering and index.** Records are `NNNN-slug.md`, contiguous from `0001`,
  English-canonical with an optional `.zh-CN.md`. The index carries one row per
  record with its failure class.
- **Guardrail ownership.** The record links each guardrail that now catches the
  class; the rule itself stays with its owner — a test, a `docs:check` row, a
  Skill convention, or a decision. The record never restates it.
- **Gate.** `docs:check` fails a misnamed record, a non-contiguous or duplicated
  number, a missing or empty required section, a status outside the enum, an
  unknown header field, a record missing from the index, and an index row that
  names no record. `docs/postmortem/README.md` and every record are contract
  documents, so a broken guardrail link is an error rather than a warning. A
  missing translation stays a warning, as for decisions.

The rule lives in the tier index and in
[doc-maintenance](../../../skills/doc-maintenance/SKILL.md); the gate is
`checkPostmortemRecord` and `checkPostmortems` in `scripts/verify-docs.mts`, with
tests in `tests/docs/verify-docs.test.ts`. The policy rows are in
[docs/README.md](../../README.md#ci-contract).

## Alternatives considered

**Keep incident stories in commit bodies.** This is the status quo, and it fails
in the case that motivated the change: the batch-restore incident spans three
commits and two distinct silent failures found by different means, so its
explanation is split across prose no index reaches. A commit body is a changelog
entry, not a record with a status that can stay `open`.

**Record incidents inside the decision that fixed them.** This is what the venv
record does, and it works when the incident is one paragraph and the fix is one
decision. It fails when no decision was made: the batch-restore incident changed a
naming and withdrew a gate, both secondary, and its actual lesson — a restore
operation that no check covers — is nobody's decision. It also gives the decision
a second job, since the format has no `Timeline` or `Root cause` section.

**Put them under `docs/experiments/`.** Experiments are measurements that become
normative when a decision accepts them, and their filenames carry the run date. A
post-mortem is a backward-looking record that establishes no measurement and outlives
the incident; reusing the tier would give every experiment reader a second document
kind with a different lifecycle.

**Extend `docs/design/improvement-areas.md`.** It lists gaps as
symptom/concern/approaches before any failure occurs, and has no state that moves
from open to resolved. A failure with evidence and guardrails would be a second
kind of entry in a file whose current-state claims the design tier governs.

**Put them in `.rcp/counterexamples.yaml`.** A counterexample is an open challenge
to a claim and must carry the input that shows the claim is false; `unsubstantiated`
exists for a concern that cannot be reproduced. A post-mortem records a failure
that happened, with a root cause and a guardrail, not a claim under challenge.

**Date-numbered filenames, as decisions and experiments use.** An incident is
referred to by class and sequence ("the batch restore that dropped a migration",
"incident 0001"), and the date is already in git. Reusing the date-first shape
would make the two tiers look alike while meaning different things: a choice and a
failure.

**Advisory checks instead of errors.** The decisions tier is the evidence against
this: three `implemented/` decisions carried `## Acceptance criteria` until
[a gate banned the heading](2026-09-09-enforce-documentation-rules.md). A tier
whose required sections are unenforced decays into a narrative pile, and an empty
section being an error is what forces an honest "not reconstructed".

**No index, directory only.** [The same 2026-09-09 decision](2026-09-09-enforce-documentation-rules.md)
removed the decision index because it duplicated the title, lifecycle, and date
that the path already encodes, and it cited DeepSeek Harness removing its own
`INDEX.md` for the same reason. That argument does not transfer: a post-mortem's
index carries the failure class, which no path component encodes, and it holds one
row per incident where the decision index held one row per decision (~30 today).
The copy is made safe in the direction that matters — a record missing from the
table fails, and a row naming a file that does not exist fails through the
contract-document link check. The accepted cost is stated under Consequences.

## Verification

- `docs:check` fails a record whose name is not `NNNN-kebab-case.md`, whose number
  is missing from a contiguous run, whose `**Status:**` is outside `open | resolved`,
  or whose required sections are missing or empty; four cases are covered by
  `post-mortem records enforce a numbered name, an exact status, and sections`.
- A gap in the numbering and a number used twice both fail
  (`post-mortem numbering is contiguous from 0001 and unique`).
- A record missing from the index, and an index row listed twice, both fail
  (`the post-mortem index lists every record exactly once`).
- A record and its `.zh-CN.md` translation are one record: both names pass, the
  number and the index row count the English name once, and the translation is held
  to the same header and sections (`a record and its translation are one record, not
two names and not a naming error`, `a translation still has to carry the record's
header and sections`). The first version of the naming rule failed the
  translation, so no record in the tier could carry one — found by the records
  another workstream wrote into the tier the same day, not by the tests, which had
  no translation case until then.
- The header field stays English while the sections may be translated, and a
  localized field says so: `**状态：**` is reported as an unknown field, not only as
  the English field it replaced being missing (`a translated header field is
reported as the unknown field it is`).
- `npm run docs:check` reports zero errors and zero warnings with the tier in
  place and no records yet.

## Consequences

- Adding an incident edits two files — the record and the index row — in each
  language it is written in. The gate holds the pair together; it cannot tell
  whether the root cause is the right one.
- The failure-class column accumulates into the list of escape classes this
  repository keeps rediscovering. Two of the three failures cited above are
  already the same class: a fallback that degrades silently instead of failing
  loudly.
- Records join the contract-document set, so a guardrail link that rots fails
  `docs:check`. That is deliberate: a record's claim is that the guardrail exists.
- Like the decisions tier, the gate checks structure and not honesty. A section
  containing "not reconstructed" passes, and no check will notice a wrong mechanism.

## Deferred

The two known incidents — the batch restore that silently dropped a parts
migration, and the benchmark venv that fell back to `PATH` python — are not yet
written as records. The tier lands first, so the entries are written against a
gate that already enforces their shape.

`Failure class` stays free text until enough records exist to name the classes as
a controlled list.
