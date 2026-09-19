# NMG post-mortems

[中文](README.zh-CN.md)

Incident write-ups. A failure reached a place it should not have — a user, `main`,
a merged pull request, a published number — and the part worth keeping is _why the
process let it through_, not the one-line fix.

This directory is the only home for failure narrative. The rule that prevents the
recurrence is not written here: it belongs to its own owner and the record links it
([doc-maintenance](../../skills/doc-maintenance/SKILL.md)). How a record turns into
that rule is under [Consumption](#consumption-from-record-to-rule).

## When to write one

Write one when all three hold:

- **Subtle.** The mechanism is non-obvious; a careful engineer would have to
  re-derive it the hard way.
- **Systemic.** The reason it escaped is a gap in tests, tooling, checks, or
  conventions, not a one-off typo.
- **Costly to rediscover.** It consumed real debugging time and would again.

An ordinary bug fix belongs in its commit. A candidate whose three answers are not
all yes is a commit body, not a post-mortem.

## What belongs here, and what does not

| Fact                                                           | Owner                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| What broke, the mechanism, why every safety net missed it      | this directory                                                                                                                                        |
| The rule, check, or test that now prevents the recurrence      | its own owner: a test file, a row of the [CI contract](../README.md#ci-contract), a [Skill](../../skills/) convention, or a [decision](../decisions/) |
| A deliberate choice, its alternatives, and its consequences    | [`decisions/`](../decisions/)                                                                                                                         |
| What was measured                                              | [`experiments/`](../experiments/)                                                                                                                     |
| An open challenge to a claim, with a reproducer                | [`.rcp/counterexamples.yaml`](../../.rcp/counterexamples.yaml)                                                                                        |
| A known gap, or unresolved work, with no failure behind it yet | [improvement-areas](../design/improvement-areas.md), [temporary-todo](../design/temporary-todo.md)                                                    |

Name each guardrail under _Guardrails added_ and link it; do not restate its rule,
because a copy of a rule is what the [slop checklist](../../skills/doc-maintenance/SKILL.md#one-home-per-fact-and-the-slop-checklist)
removes.

## Required sections

The header block — the lines before the first section — carries one field:

```markdown
**Status:** open | resolved
```

The field name and its colon stay English in every record, a `.zh-CN.md`
translation included; the section headings are what may be translated (the check
reads either spelling). The status is the field because it is what a reader — and
the promotion trigger below — searches for.

`resolved` means the guardrails exist and are linked. `open` means the failure is
understood and not yet caught; an unfixed incident still gets a record, because the
mechanism is the expensive part to rediscover. The failure date lives in the commit;
state it under _Timeline_ when it matters.

Every record answers the questions below with a non-empty section each. A section
that genuinely has no answer says so in words ("not reconstructed") rather than
being omitted or left empty; `npm run docs:check` fails a missing or empty one.

| Section           | The question it answers                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Executive summary | One paragraph a busy reader absorbs in 30 seconds: what broke, the root cause in plain terms, why it escaped, the lesson. |
| Summary           | What happened, in enough detail to judge the rest                                                                         |
| Impact            | Who or what was affected, and what the failure could _not_ do                                                             |
| Timeline          | The order that produced it, including the reviews and checks that passed in between                                       |
| Root cause        | The mechanism, stated so a reader can predict the next instance of the class                                              |
| Guardrails added  | Each guardrail that now catches this class, linked to the file or document that owns it                                   |
| Lessons           | What transfers beyond this incident                                                                                       |

## Naming and the index

Records are numbered `NNNN-slug.md` in this directory, contiguous from `0001`. The
number is how an incident is referred to; the date is in git. Records are normally
paired with a `.zh-CN.md` counterpart; a missing translation warns, exactly as for
decisions.

The [index](#index) lists every record once and carries its **failure class** — the
searchable axis no filename and no title has. Add the row in the same change that
adds the record: `docs:check` fails a record missing from the index and a row that
names no record. Write the class as a short noun phrase ("silent degradation",
"batch overwrite", "verification blind spot") so the column accumulates into the
list of escape classes this repository keeps rediscovering.

## Consumption: from record to rule

A record is evidence that a class of failure exists; it is not a guardrail. A
guardrail is a mechanism that fails loudly next time. This section decides whether
and where a class earns one.

**Prefer a gate to a reminder.** Promote a class to the first of these that can
carry it:

| If the class is...                   | it becomes a...                                          | owned by                                                                                 |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| detectable by a machine              | a check                                                  | a row of the [CI contract](../README.md#ci-contract), a test, or a verifier branch       |
| a session behaviour no check can see | a standing rule                                          | the owning `AGENTS.md` or [Skill](../../skills/), one to three lines, linking the record |
| a judgement with real alternatives   | a decision record                                        | [`decisions/`](../decisions/)                                                            |
| a local convention                   | a section in the document that already owns that process | that document                                                                            |

**Promote when any of these holds:**

- the class has escaped twice — the index shows two records with the same failure
  class;
- the guardrail exists only as prose inside the record — the record claims a rule
  that no check, standing document, or decision owns;
- the record is `open`, so the class is still live.

**Do not promote** a single occurrence whose prevention would cost more than the
failure, or whose mechanism cannot recur in this repository. That is a valid
outcome: the record says so in `Lessons` ("no rule; this stays a story") rather
than leaving the question open.

**Every record is written after the fact.** A record normally follows the failure
and often the fix, so promotion is a reconciliation rather than a plan: name and
link the guardrail that already exists under _Guardrails added_, then test it
against the preference order above. If the only guardrail is the record's own
prose, the class is not caught and the record is not `resolved` — either it gains a
guardrail, or `Status: open` says why it cannot.

Promotion into a Skill or `AGENTS.md` is
[approval-gated](../decisions/implemented/2026-09-09-approval-tiers.md). Revise this
section when the corpus shows it misfiring — classes accumulating with no rule, or
a rule nothing needed — through
[the meta-rule](../../skills/doc-maintenance/SKILL.md#meta-rule-nmgs-own-rules-are-governed)
rather than by edit.

## Classes and typical cases

The index carries each record's class as free text. This table is the taxonomy:
one row once a class has a canonical case — the record a reader should read first
— and the rule the class produced. A class whose rule cell is empty is a class
nothing catches yet, which is the point of writing it down.

| Class                   | Canonical case | Rule it produced |
| ----------------------- | -------------- | ---------------- |
| unchecked tooling       | 0001           |                  |
| wrong-tree verification | 0002           |                  |
| mutant-in-tree reading  | 0003           | the sweep's lock: `agent:verify` refuses to report, and a new sweep refuses to start, while one holds the tree (`tools/mutation-lock.ts`) |
| mislabelled flake       | 0004           | an intermittent failure is recorded with its reproduction attempt and rate, or left open - never as "flaky" (`skills/repo-development/SKILL.md`) |
| -----                   | -------------- | ---------------- |

A class name is a short noun phrase, not a sentence, and it is not invented before
there is a case to point at: the first record names the class, the second one
confirms it. A record's class lives in the index, not in the record, so there is
one place to read the whole taxonomy.

## Index

| #    | Record                                                                                        | Failure class           |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------- |
| 0001 | [The tool that checks the others is not itself checked](0001-tools-outside-the-type-check.md) | unchecked tooling       |
| 0002 | [The tree I verified was not the tree I pushed](0002-wrong-tree-verification.md)              | wrong-tree verification  |
| 0003 | [The checks I read were reading a mutant](0003-checks-read-a-live-mutant.md)                  | mutant-in-tree reading   |
| 0004 | ["Flaky" was a clock boundary](0004-flaky-was-a-clock-boundary.md)                            | mislabelled flake        |
