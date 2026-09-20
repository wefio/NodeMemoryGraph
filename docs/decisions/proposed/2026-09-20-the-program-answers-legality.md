# The program answers legality, and nothing else

[中文](2026-09-20-the-program-answers-legality.zh-CN.md)

**Status:** proposed
**Relates to:** [Board governance and capability addressing](../implemented/2026-09-06-board-governance-addressing.md), [Name the collaboration protocol and its task-unit sub-protocol](../implemented/2026-09-20-name-the-collaboration-protocol.md), [Task unit semantics](../../design/task-unit-semantics.md), [The contract's obligations](../../design/task-unit-semantics-obligations.md)

## Problem

The primitives have names, and the shared layer can already compute the legal set: an ordered legal set,
that set cut to the declared slot budget, and a refusal reason per unit when a claim is checked. What no
document states is **whose decision each step is**. The cost of that gap is observable: every caller
that wants to drive a run has to redraw the boundary for itself, so both recorded failure modes come
back - a program that picks the person for the agents, which is the scheduler the naming decision
records as the word this model deliberately did not become, and agents that cannot tell what the program
guarantees, so they ask for what they actually need in the only terms available: more slots, stranger
ordering.

[The obligations ledger](../../design/task-unit-semantics-obligations.md) says where the boundary must
not move - no second task body, no dedicated tool, no dedicated channel - but it does not say what the
program's answer is. Neither does the board's correctness line - reviewable finalize, authentic
content, scope isolation, capability addressing ([board governance and capability
addressing](../implemented/2026-09-06-board-governance-addressing.md)) - which governs how an entry is
treated once it exists, not who decides what happens next.

## Proposal

Three owners, three kinds of statement. The program's share is exactly one: **it answers legality**.

- **The protocol owns** what the primitives are (already named; this record does not restate them), the
  definition and criteria of legality, which constraints exist **by name**, and the two structural
  rules that are what "legal" means here and therefore cannot be negotiated: a claim (lease plus
  attempt fence) is the only arbiter of who holds a unit, and a deliverer never judges its own
  delivery.
- **The accompanying program owns** computing the ordered legal set from the declared plan and current
  facts, cutting it to the declared slot budget, and stating for each unit why it is legal or not -
  reusing the reasons it already refuses claims with. It chooses nobody, adopts nothing, judges
  nothing, and wakes nobody.
- **Agents own the arrangement**: the plan's content, the order they agree on, who takes which unit,
  who adopts a run, who judges. All of it lands as board facts, so the arrangement is readable and
  auditable instead of being implied by a program's choice.

**Constraints are named by the protocol and enabled by the plan.** A preference such as repair-first is
neither a program policy nor merely advice: it is a named constraint that a plan - or the adopter
declaring it - enables, and the legality answer is computed under the enabled set. A constraint that is
not enabled must be genuinely absent from the answer, or the declaration is decoration.

**Legality is asked, not published.** It is a function of current facts, so a query returns the ordered
legal set with a reason per unit, changing no state. A published handoff on the board is a different
thing: by the board's own protocol it occupies a serial slot. Fusing the two into one action would make
asking a question consume a slot.

## Plan

1. This record: write down the division of labour and the standing of constraints. No product surface.
2. Make legality readable through an existing board action (the action name lives in the shared
   tool contract, its description is generated from the prompt source), keeping the read free of state.
3. Promote the preferences that currently live as shared planning policy - repair-first first - into
   named constraints a plan declares, which is what makes the "disabled means absent" criterion true.

Each step is verifiable on its own; none of them requires a driver, a wake, or a new tool.

## Alternatives considered

- **Let the program select the next unit** (today's `next()` used as policy). Rejected: a bound is not a
  decision - it does not choose among legal successors - and a program that picks the person is a
  scheduler again, which the naming decision records as the word this model deliberately did not become.
- **Let the program store state only, with agents asserting their own legality.** Rejected: "legal"
  would then be whatever the loudest caller says, and the two structural rules (one holder per claim,
  no self-judging) would lose their home.
- **Demote preferences to advice.** Rejected: the arms compare runs on the premise that the same plan
  plus the same facts yield the same answer, and advice that may be ignored removes exactly that.
- **Publish the legal set as a board offering** (make the query a handoff). Rejected: it makes a
  question consume a serial slot, and withdrawing an offer is the board protocol's business.
- **Give the arrangement its own tool or channel.** Rejected: the ledger forbids it; the primitives must
  take effect through an ordinary handoff.
- **Keep repair-first as hidden program policy.** Rejected: same class as a program that picks the
  person.

## Acceptance criteria

- The answer is per unit, ordered, and carries the reason for each legal or refused unit.
- The answer names no person, no adopter and no judge.
- Asking changes no state: no entry, no claim, no slot, no wake. Asking twice on an unchanged store
  returns the same answer, and the store's version is unchanged.
- A constraint that is not enabled has no effect on the answer: enabling and disabling the same named
  constraint on one plan yields different legal sets.
- The declared slot budget still cuts the answer, and declaring more than one slot still requires a
  declared handoff target.
- The two structural rules hold in the answer's own terms: a second claim on a held unit is refused,
  and a deliverer cannot judge.
- Who adopted, who claimed and who judged exist only as board facts; no program field asserts them.
- The ledger's prohibition still holds: no new tool, no dedicated channel, no second task body.

## Risks

- With no constraint declared, a wide legal set can read as permission to fan out, recreating the
  "no discussion, everything at once" problem somewhere new. Mitigation: the slot budget stays a
  declared cap rather than a social one.
- Repair-first currently lives as policy inside the shared planning code, so making it a declared
  constraint is a change rather than a rename; until it moves, the answer is computed under an implicit
  constraint, which is the one place this proposal is not yet true.
- Reasons become an interface: a caller that parses a reason string creates a second source of truth.
  Reasons are for people and logs; any caller decision must go through a claim or an explicit field.
- With agents free to choose order, the arms' equal-instrument premise depends on each run recording
  which constraints were enabled; an unrecorded set makes two runs incomparable.
- A query invites polling. Polling is cheap, and a caller that asks and then acts can still race - the
  claim remains the arbiter, which is the point.
