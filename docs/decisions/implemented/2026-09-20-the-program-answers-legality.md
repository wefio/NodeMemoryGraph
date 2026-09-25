# The program answers legality, and nothing else

[中文](2026-09-20-the-program-answers-legality.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Mechanism, not policy](../proposed/2026-09-21-mechanism-not-policy.md), [Board governance and capability addressing](2026-09-06-board-governance-addressing.md), [Name the collaboration protocol and its task-unit sub-protocol](2026-09-20-name-the-collaboration-protocol.md), [Task unit semantics](../../design/task-unit-semantics.md), [The contract's obligations](../../design/task-unit-semantics-obligations.md), [Protocol-governed collaboration: the parts, the gaps](../../design/protocol-governed-collaboration.md)

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
addressing](2026-09-06-board-governance-addressing.md)) - which governs how an entry is treated once it
exists, not who decides what happens next.

## Decision

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
declaring it - enables, and the answer is computed under the enabled set. A constraint that is not
enabled must be genuinely absent from the answer, or the declaration is decoration. The names the
protocol defines are a closed list (`PLAN_CONSTRAINTS`), and a plan naming one outside it is refused by
name, because reading an unknown name as "nothing was asked for" is exactly the decoration this rule
forbids. Enabling nothing is a setting rather than a fallback: a plan that enables nothing runs one unit
per session.

**Legality is asked, not published.** It is a function of current facts, so a query returns the ordered
legal set with a reason per unit, changing no state. A published handoff on the board is a different
thing: by the board's own protocol it occupies a serial slot. Fusing the two into one action would make
asking a question consume a slot.

## Implementation state

**Step 1** is this record: the division of labour and the standing of constraints, with no product
surface.

**Step 2, landed 2026-09-23.** The board port's read is `legality()`: the ordered legal set, the room the
run has left, and a named cause for every unit the rules do not have on offer. The causes are computed
inside the rules' own `selection`, so a cause names a gate rather than restating it, and `candidates()`
is that answer's `legal`, so the port's two read verbs cannot disagree. The invariant is mechanical: no
refusal is silent over 64 flag combinations times two slots. The asker is the process that owns the
run's workspace - a plan compiles from the caller's files while the daemon holds only their frozen paths
- so the shared tool contract's wording is unchanged, because the read it describes is the same read.

**Step 3, landed 2026-09-23.** The continuation is a declared constraint, not the planner's default:
`src/integration/ooo-fusion-plan.ts` owns `PLAN_CONSTRAINTS`, reads the plan's declaration before it
continues a session, and refuses a name outside the list. Every caller that wants a fused run now
declares it: the arm driver's spec carries the declared set and is refused when a spec declares a bound
above one without enabling the constraint - such a run would be the control arm while its file said
fusion.

What is demonstrable is a different **move** at a session boundary under an enabled constraint, not a
different legal set: repair-first orders a session, it does not gate membership, and a name that changed
which units are legal would be a different kind of answer. The criterion was corrected here rather than
quietly restated.

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
- **Read an absent declaration as the old behaviour** (default a plan to repair-first). Rejected: that
  is the same implicit policy with a default attached, and it leaves "disabled" with no way to be said.

## Consequences

- **Every fused run declares the constraint.** Three test fixtures, the arm driver's spec and the trial
  spec generator carry it now, and the driver refuses a spec that declares a bound it did not enable.
  The measurement of any fused arm depends on a spec that declares it, which is the point: two runs are
  comparable only if each records which constraints it enabled.
- **A constraint is a protocol act.** The vocabulary is closed and an unknown name is refused by name,
  so adding one is a change to the protocol, not a string a caller may invent.
- **What a constraint may change is still unwritten.** This rule orders a session; nothing yet says
  whether a constraint may change which units are legal. That is what the umbrella's row 10 gap became
  after this landed.
- **The run's recorded `policy` is a label, not the switch.** The probe board compares it with the
  policy it expects; the planning decision is read from the plan's declaration. Two homes for one rule
  would be the defect this decision exists to avoid, so the recorded name is deliberately not wired to
  the move.
- **Reasons are for people and logs.** A caller that parses a reason string would create a second source
  of truth; a caller's decision goes through a claim or an explicit field.
- **Asking stays free.** No entry, no claim, no slot, no wake; the store's version is unchanged, and the
  same store yields the same answer. A caller that asks and then acts can still race, and the claim
  remains the arbiter.
- **Nothing here answers two neighbouring gaps.** A process holding only the store cannot ask (a plan
  compiles from the caller's files), and work left in doubt across runs still has no clause; the
  umbrella keeps both.
