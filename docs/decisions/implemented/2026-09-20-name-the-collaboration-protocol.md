# Name the collaboration protocol and its task-unit sub-protocol

[中文](2026-09-20-name-the-collaboration-protocol.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Task unit semantics](../../design/task-unit-semantics.md), [The dispatch loop is shared](2026-09-19-dispatch-loop-is-shared.md)

## Problem

The arrangement this line is building had no name, so every discussion had to re-derive what it
meant: whether the subject was the board, the run object, the verbs an Agent uses, or the rules that
decide. The words that came to hand were already taken in ways that invite the wrong reading.
_Fusion_ names one mechanism (several units sharing a session: `sharedSessionLegal`,
`fusionAccounting`), and a _scheduler_ is what the task-unit semantics decision explicitly does not
enable. _Governance_ is the board addressing and readability line, _ledger_ already names three
things (assumptions, budget, disclosure), and _executor_ names the bounded context adapters and the
Pi SDK execution path. Naming the new thing after any of those would make the conversation shorter
and the understanding worse.

## Decision

Two levels, each with one meaning:

- **Protocol-governed collaboration** is the umbrella: agents coordinate through a published
  protocol, and the mechanics of that coordination belong to the program rather than to the model's
  discussion. It is the larger idea the board's verbs are one instance of.
- **Task-Unit Protocol** is the sub-protocol this line builds: a task is declared as a unit (inputs,
  dependencies, acceptance, capability, budget), and the protocol fixes how that unit is adopted into
  one run, claimed, delivered and independently judged, and which facts the runtime decides and owns.
  "Task unit" is the word the design already uses; the protocol half is what was missing.

The parts keep their existing names instead of acquiring new ones: **Task Board** is the
sub-protocol's surface, **managed entry** is what an entry becomes once a run governs it, **run** is
the object whose plan, tasks and facts are frozen, and **adopt** is the transition that binds an
entry to a run. The one thing with no name is the caller that decides to adopt; this record calls it
the **adopter**.

## Alternatives considered

- **Keep saying OoO.** Rejected as the umbrella: `ooo` is the project's own name for the scheduling
  model it implements and is load-bearing in more than a hundred documents, but it names the model,
  not the two-part arrangement of who discusses and who decides, so it does not remove the ambiguity
  the naming exists for.
- **Board-governed execution.** Rejected: `governance` is already the board addressing and
  readability line, and the phrase reads as the board deciding, which is the opposite of the point
  that the program decides.
- **Task-unit lifecycle protocol.** Rejected as too long to say; the lifecycle reading is recoverable
  from the definition without being carried in the name.
- **Managed run protocol.** Rejected because it drops the semantics half, which is the larger part of
  the design and the half the board cannot check by itself.
- **A name built on "fusion".** Rejected: execution fusion already names one mechanism, and adoption
  and dispatch happen whether or not any session is fused.
- **Rename code or the design document to match.** Rejected for the reason the check-runner renaming
  recorded: the `ooo` term and the existing paths are cited by dated measurement records and frozen
  run archives, so a rename would leave evidence pointing at paths that no longer exist.

## Consequences

- A discussion can now name its level: protocol-governed collaboration for the whole arrangement, the
  Task-Unit Protocol for the semantics-plus-runtime sub-protocol, the adopter for the missing caller,
  and the existing words (board, run, adopt, managed entry) for the parts.
- No identifier changes. `run`, `adopt`, `managed`, `dispatch`, the `ooo-` file prefix and every file
  name stay as they are, so no historical record needs repairing.
- The name lives in the concept map with aliases for search. `docs/glossary.yaml` is untouched: it
  owns the repository and process vocabulary, and this is a product concept.
- The naming builds nothing. The sub-protocol's mechanism exists (the run surface, the managed-write
  fence, the shared dispatch loop) and the product path still has no adopter, which is the next piece
  of work rather than a consequence of the name.
