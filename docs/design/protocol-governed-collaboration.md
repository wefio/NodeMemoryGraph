# Protocol-governed collaboration: the parts, the gaps, and the distributed systems behind them

[中文](protocol-governed-collaboration.zh-CN.md)

The umbrella name is [protocol-governed collaboration](../decisions/implemented/2026-09-20-name-the-collaboration-protocol.md).
This document is an inventory of it: which sub-protocols exist, which one is complete, which are missing,
and which of those - existing or missing - already have a name in distributed systems.

It is an index, not a second specification. Each part's owner is named in its row, and where this
document and an owner disagree, the owner wins.

## What the umbrella is made of

| Part                            | What it governs                                                                                                                                                             | State                                                                  | Owner                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entries and addressing          | Typed, attributed, expiring entries; compact reads, cursors, inbox; directed delivery (`to=`), discovery, capability addressing (`need`)                                    | Complete                                                               | [board governance and capability addressing](../decisions/implemented/2026-09-06-board-governance-addressing.md), [board find/direct and serial](board-find-serial-a2a-compat-2026-08-13.md)           |
| Identity and authenticity       | Writer attribution, content hash by default, signing across a trust boundary                                                                                                | Complete                                                               | [board governance and capability addressing](../decisions/implemented/2026-09-06-board-governance-addressing.md)                                                                                       |
| Ownership and time              | Atomic compare-and-set claim, lease with lazy expiry, renewal, release, serial promotion of the next pending entry                                                          | Mechanism complete; the responsibility to restart work is not assigned | `src/core/store/base.ts`, [board find/direct and serial](board-find-serial-a2a-compat-2026-08-13.md)                                                                                                   |
| Termination integrity           | Reviewable finalize and veto, `deliver` with a digest, independent `judge`, attempt fencing, `undecidable` as a first-class outcome                                         | Complete                                                               | [board governance and capability addressing](../decisions/implemented/2026-09-06-board-governance-addressing.md)                                                                                       |
| Attention and wake              | Directed wake of one session, membership by subscription, silent notes, acknowledgement suppressing re-notification                                                         | Complete                                                               | [board find/direct and serial](board-find-serial-a2a-compat-2026-08-13.md)                                                                                                                             |
| Scope and visibility            | An entry targets an authorized agent subset, so boards are not all-to-all                                                                                                   | Complete                                                               | [board governance and capability addressing](../decisions/implemented/2026-09-06-board-governance-addressing.md)                                                                                       |
| Truth versus coordination state | The board is a temporary coordination medium; durable memory is the truth store; `memory=<id>` pointers                                                                     | Complete                                                               | [board governance](../decisions/implemented/2026-09-06-board-governance-addressing.md), [memory graphs](memory-graphs.md)                                                                              |
| The task unit                   | A unit declared by inputs, dependencies, acceptance, capability and budget; decomposition; the internal compile view; the run, its adoption, and the facts the runtime owns | Complete                                                               | [task unit semantics](task-unit-semantics.md), [the obligations ledger](task-unit-semantics-obligations.md)                                                                                            |
| Legality and admission          | The ordered legal set, the cut to the declared slot budget, the reason each unit is or is not legal                                                                         | Mechanism complete; the readable answer is missing                     | `src/integration/ooo-board.ts`, [the program answers legality](../decisions/proposed/2026-09-20-the-program-answers-legality.md)                                                                       |
| Ordering and constraints        | Determinism (one plan plus one set of facts yields one answer), repair-first, tie-breaking by plan order                                                                    | Mechanism complete; the declaration is missing                         | [fusion planning: repair-first](../decisions/implemented/2026-09-19-fusion-planning-repair-first.md), [the program answers legality](../decisions/proposed/2026-09-20-the-program-answers-legality.md) |
| Budget and accounting           | Declared slot budget, token and cache accounting, the offline cost ceiling                                                                                                  | Complete                                                               | [declared slot budget](../decisions/implemented/2026-09-18-declared-slot-budget.md), [the cost model](../experiments/execution/ooo-cost-model-2026-09-17.md)                                           |
| Cancellation and fencing        | Explicit cancellation, no orphan worker or check after it, late artifacts fenced                                                                                            | Complete                                                               | [long checks run detached](../decisions/implemented/2026-09-18-detached-long-checks.md), [the bootstrap design](ooo-execution-bootstrap.md)                                                            |
| Recovery and replay             | Log plus replay of a round, the transactional outbox drained after commit and on restart, no stealing another's work after a crash                                          | Complete inside the arms; the product side is not wired                | [the bootstrap design](ooo-execution-bootstrap.md)                                                                                                                                                     |
| Handoff                         | Session identity comes from the board; a continuation surface carries what the next holder needs                                                                            | Complete                                                               | [session identity comes from the board](../decisions/implemented/2026-09-19-session-identity-comes-from-the-board.md), [session continuation obligations](task-unit-semantics-obligations.md)          |
| Evidence and audit              | Run facts, verification evidence, traceability aggregation                                                                                                                  | Complete                                                               | [rtm evidence aggregation](../decisions/implemented/2026-09-20-rtm-evidence-aggregation.md)                                                                                                            |

No single part completes a task. A task completes when the unit's declaration, ownership and time,
termination integrity, attention, legality, budget, truth separation and handoff all hold at once; the
rows above are the ones a given piece of work cannot do without.

## The gaps, and the concepts available for them

1. **The adopter has no protocol clause.** Who may adopt a discussion into a run, and who is responsible
   for restarting work after a lease lapses, is not stated. The mechanism exists (`expiry`, serial
   promotion, the dispatch loop), the responsibility does not. Distributed systems call the first one a
   **commit boundary** - the single point that makes a discussed arrangement binding - and the second an
   **orphan reaper / restart responsibility**.
2. **Legality has no readable answer.** A caller can claim and be refused, but cannot ask what is legal
   and why. That is **admission control** with a **read-only precondition check**.
3. **Constraints have no declaration.** Repair-first currently lives as policy inside shared planning
   code. Making preferences named constraints a plan enables is **declarative policy**, and the
   requirement that one plan plus one set of facts yields one answer is **deterministic replay**.
4. **Read guarantees are unwritten.** Board reads are cursor-based and may lag; nothing states whether a
   reader may assume monotonic reads or read-your-writes. The concepts are **monotonic reads**,
   **read-your-writes** and, across one agent's own sequence of sessions, **causal consistency**.
5. **Disagreement has no arbiter.** Two agents that disagree about what to do next can only contest a
   completion (`veto`) or race a claim. There is no clause for settling the disagreement itself. The
   closest concepts are **optimistic concurrency with conflict detection** and, because one arbiter
   already exists, a plain **single-writer decision**. Competitive allocation was already refused
   ([board governance](../decisions/implemented/2026-09-06-board-governance-addressing.md)).
6. **Cross-run resources have no mutual exclusion.** Several runs competing for one worktree or one file
   are handled by practice (a throwaway worktree per arm) and by the slot budget, not by a rule. The
   concept is a **fenced mutex** - a lock whose holder cannot be believed after its lease lapses.
7. **In-doubt work has no resolution.** A delivery that nobody judged is `undecidable` when the run ends,
   but an artifact left in doubt across runs has no clause. This is precisely an **in-doubt transaction**:
   the fact is known, the outcome is not, and somebody has to resolve it or write down why not.

## The concepts this system deliberately does not need

- **Consensus, leader election, quorum, two-phase commit.** Truth lives in one store written by one
  daemon, so there are no replicas to agree; the only fact needing agreement is who holds a claim, and a
  single atomic compare-and-set provides it.
- **Exactly-once delivery.** What is delivered is an artifact plus a judgement, not a message. Repeating
  work costs tokens and wall time, and that difference from a CPU, where replay is nearly free, is why
  speculation measured as cost without gain in [the arms](../experiments/execution/archive/ooo-arms-2026-09-19/README.md).
- **Distributed transactions.** One run commits once; there is no atomic commit spanning parts.

## Three analogies that mislead

1. **Lease expiry is not death.** Expiry is a failure detector, and a detector reports a suspicion, never
   a fact. The system already answers this correctly with attempt fencing - a new holder starts attempt
   N+1, which voids the previous attempt's artifact and verdict - and that property must not be traded
   away for convenience.
2. **The board is not a message queue.** It is a shared, attributed, expiring entry space: entries persist
   and are re-read, so re-reading is normal and re-doing is the problem. Treating it as a queue would
   make every reader a consumer and every re-read a duplicate.
3. **Agents are not replicas.** They do not agree by construction, they each judge independently, and
   that independence is the point - it is why the board records what was delivered and who judged it
   rather than trusting a self-report.

## What would make this inventory complete

Rows 9 and 10 are the interfaces the legality proposal covers: the readable answer and the declared
constraint set. Rows 1, 4, 5, 6 and 7 are gaps with no owner yet. Until each gap either gets a clause or
is written down as deliberately absent, "complete" for this umbrella means the parts that have owners,
not the parts a task needs.
