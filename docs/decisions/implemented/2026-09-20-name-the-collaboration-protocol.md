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

## The names, in one place

This is an index, not a second specification: one line of meaning and a pointer per name, and where a
row and its owner disagree, the owner wins. It exists because the definitions used to be reachable
only by opening the design, the obligations ledger and the decision records side by side.

The two levels and what they are made of:

| Name                            | One line                                                                                                                                              | Contract owner                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol-governed collaboration | Agents coordinate through a published protocol, while the mechanics and the deciding stay with the program                                            | this record; [concept map](../../guides/concept-map.md)                                                                                                                      |
| Task-Unit Protocol              | A task is declared as a unit and the protocol fixes its adoption, claim, delivery, judging and the facts the runtime owns                             | [task-unit-semantics.md](../../design/task-unit-semantics.md), [its obligations ledger](../../design/task-unit-semantics-obligations.md)                                     |
| task unit                       | A unit of work that can be handed off, verified and independently voided, declared by inputs, dependencies, acceptance, capability and budget         | [task-unit-semantics.md](../../design/task-unit-semantics.md)                                                                                                                |
| Task Board                      | Attributed, expiring, task-scoped Agent coordination outside semantic memory                                                                          | [memory-graphs.md §2](../../design/memory-graphs.md#shared-task-board-cross-agent-coordination-not-a-memory-graph)                                                           |
| entry                           | One board item - goal, question, handoff, blocker, result, note or decision - carrying a claim lease, deliveries and verdicts                         | [board-find-serial-a2a-compat](../../design/board-find-serial-a2a-compat-2026-08-13.md)                                                                                      |
| wake                            | A directed entry notifies that Agent's session; the board does not decide who works, only that someone was addressed                                  | [board-find-serial-a2a-compat](../../design/board-find-serial-a2a-compat-2026-08-13.md)                                                                                      |
| serial channel                  | At most one un-directed actionable entry is pushed at a time; the next is promoted when the outstanding one is claimed or resolved                    | [board-find-serial-a2a-compat](../../design/board-find-serial-a2a-compat-2026-08-13.md)                                                                                      |
| claim, release, resolve         | The lease verbs: one holder at a time, expiry returns the entry to the pool, a resolve closes it                                                      | [board governance and addressing](2026-09-06-board-governance-addressing.md)                                                                                                 |
| deliver, judge                  | A claim ends in a digest-bound deliverable, judged by a different Agent (accepted, rejected, undecidable)                                             | [board governance and addressing](2026-09-06-board-governance-addressing.md)                                                                                                 |
| managed entry                   | An entry a run has adopted: its lifecycle verbs are refused outside that run's coordinated scope                                                      | [obligations ledger, B6](../../design/task-unit-semantics-obligations.md)                                                                                                    |
| run                             | The frozen object: a registered run, one frozen plan, bound entries and the fact log, reached over `taskRun`                                          | [obligations ledger, D11 and D13](../../design/task-unit-semantics-obligations.md)                                                                                           |
| adopt                           | The transition that binds a board entry to a run, recorded as the run fact `entry-bound`                                                              | [obligations ledger, D12](../../design/task-unit-semantics-obligations.md)                                                                                                   |
| adopter                         | The caller that decides to adopt; the one name here with no product implementation yet                                                                | this record; [obligations ledger, what is left](../../design/task-unit-semantics-obligations.md)                                                                             |
| run fact                        | One recorded transition of a run: `entry-bound`, `board-claim`, `board-deliver`, `board-judge`, `run-cancelled`                                       | `src/integration/task-coordinator.ts`                                                                                                                                        |
| legal action set                | The deterministically computed set a source may rank within, cut to the declared slot budget                                                          | [declared slot budget](2026-09-18-declared-slot-budget.md), `src/integration/ooo-execution.ts`                                                                               |
| dispatch loop                   | The shared sequential loop that drives a plan unit by unit, with the board behind a port                                                              | [the dispatch loop is shared](2026-09-19-dispatch-loop-is-shared.md)                                                                                                         |
| session, fusion                 | A unit's session is keyed on the board rather than the harness; fusion is several units sharing one session, a mechanism and not this protocol's name | [session identity comes from the board](2026-09-19-session-identity-comes-from-the-board.md), [fusion legality and accounting](2026-09-18-fusion-legality-and-accounting.md) |

Two words that are deliberately not used for this protocol:

| Word        | Why not                                                                                                                                   | Owner of the real meaning                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| scheduler   | The semantics deliberately does not enable one: ordering is deterministic rules over the legal set plus a declared budget                 | [task-unit semantics](2026-09-13-task-unit-semantics.md)           |
| OoO, `ooo-` | The project's own name for the scheduling model it implements, and the file prefix; it names the model, not who discusses and who decides | [ooo-execution-bootstrap](../../design/ooo-execution-bootstrap.md) |

## Where the words came from

The vocabulary is the residue of six steps, none of them planned as a naming exercise. Commit-level
lineage lives in [implementation-lineage.md](../../design/implementation-lineage.md); this is the
conceptual one, because the names only make sense in this order.

| When                | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Where it is owned                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-13          | The board was already an explicit multi-Agent coordination surface shared by several adapters, and it became a **protocol**: identity registration and discovery that wake no LLM, directed delivery (`to=<agent>`), and serial admission decided by claim, resolve and expiry rather than by arrival or acknowledgement - taking over is the claim, so a delivery is not a handover. A2A compatibility was researched at the same time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [board find/direct and serial](../../design/board-find-serial-a2a-compat-2026-08-13.md)                                                                     |
| 2026-09-06          | Governance and addressing: capability keys, compact reads, writer attribution. Still coordination - nothing here executes anything.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [board governance and addressing](2026-09-06-board-governance-addressing.md)                                                                                |
| 2026-09-09 to 09-11 | **Out-of-order execution is borrowed from the CPU, with its limits written down.** The correspondence that holds is out-of-order execution _with in-order commit_: workers run out of order, the plan and its tickets are the reorder buffer, the coordinator is the only retire stage, and the acceptance rules define what counts as commit. Two limits are recorded with it. This design is stricter than the field's default of unbounded parallelism: only a real external wait may pass the queue head, and no sleep may manufacture reordering. And speculation is gated on measured payoff, because the CPU's premise does not transfer - there a wrong guess wastes resources already committed or free, while here it spends tokens and wall time (a worker call measured at 40-56 s). The decision adopts only the class whose wrong guess costs no tokens and refuses the class that hides a wait by guessing it; where a guess would almost always hold, the recorded advice is to remove the dependency rather than speculate it. | [bootstrap design](../../design/ooo-execution-bootstrap.md), [gate speculation on measured payoff](2026-09-11-ooo-speculation.md)                           |
| 2026-09-13          | Borrowing OoO makes the decomposition the bottleneck, and that half gets its own semantics: a **task unit** declared by inputs, dependencies, acceptance, capability and budget, compiled into an internal view (Task IR). Deliberately not a new user-facing language and not a second schema.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [task-unit-semantics.md](../../design/task-unit-semantics.md)                                                                                               |
| 2026-09-18 to 09-19 | **The paid arms measure both borrowed halves.** Fusing sessions buys wall time and costs tokens. Bounded speculation measures as cost with no gain at the shape tried: 43k tokens over six units, a false fact wasting 20 332 tokens, prepared candidates publishable in 0 of 3 holds, and 175 ms of verification against 6.2 s of work once the fact holds. The half of out-of-order execution that assumes a guess is cheap is therefore not available to agents, and the records say so instead of claiming a gain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [arms archive](../../experiments/execution/archive/ooo-arms-2026-09-19/README.md), [obligations ledger F5](../../design/task-unit-semantics-obligations.md) |
| 2026-09-12 to 09-20 | **The board absorbs the execution half.** The first shape gave OoO its own session surface and its own tool; that was abandoned in favour of changing the board protocol itself. The board gained a deliverable bound to a digest, an independent judge, attempt fencing, then the run as a frozen object, adoption as a fact, the managed-write fence and the daemon's run surface - and the round's own tool left the product tool directory, so an ordinary handoff now carries semantics, execution and acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [collaboration absorbs OoO](../../design/task-unit-semantics-obligations.md), [the dispatch loop is shared](2026-09-19-dispatch-loop-is-shared.md)          |

The sequence is what the two names describe: protocol-governed collaboration, because the board was
already a protocol before it became an execution surface, and the Task-Unit Protocol, because the fine
decomposition is the part a task's semantics had to supply. It also explains the words recorded as
rejected above: a scheduler is what this model deliberately did not become, OoO is the borrowing's own
name, and fusion is one measured mechanism inside it rather than the whole.

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
