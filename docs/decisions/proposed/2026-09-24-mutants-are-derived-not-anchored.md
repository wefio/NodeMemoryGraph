# A tooth is an operator over a symbol, not a copy of a line

[中文](2026-09-24-mutants-are-derived-not-anchored.zh-CN.md)

**Status:** proposed
**Approved:** explicit
**Relates to:** [Tests do not need a filesystem](../implemented/2026-09-20-tests-need-no-filesystem.md), [The checks read a live mutant](../../postmortem/0003-checks-read-a-live-mutant.md), [Bound agent verification as one run](../implemented/2026-09-23-verification-whole-run-deadline.md), [The contract's obligations](../../design/task-unit-semantics-obligations.md), [Mechanism, not policy](2026-09-21-mechanism-not-policy.md)

## Problem

Every rule this repository has decided to protect is protected the same way: a named mutant in
`tools/mutation-teeth.ts` that replaces a byte range with a hand-written replacement, plus the name of
the case that must fail when it does. That evidence is honest - a mutant is the only form that speaks
about the implementation's freedom to be wrong - and it is also the most fragile artifact in the tree,
because **the anchor is the mutant's identity**. It is a copy of a line, so the line moving, being
inlined, or having its message text extracted retires the tooth.

Measured on 2026-09-24, at 149 mutants over 22 targets:

| What the anchor points at                             | Mutants | Share | Already scoped to a member |
| ----------------------------------------------------- | ------- | ----- | -------------------------- |
| A guard or predicate term neutralised (G)             | 64      | 43%   | 30                         |
| A value, argument, index or callee substituted (V)    | 58      | 39%   | 26                         |
| A statement or call removed (R)                       | 11      | 7%    | 6                          |
| Code inserted: a statement, branch or second copy (I) | 8       | 5%    | 4                          |
| An expression replaced wholesale (E)                  | 8       | 5%    | 5                          |

Two readings decide this record. **89% of the teeth (133 of 149) are a site plus one of a handful of
operators** - disable a condition, drop a term, substitute an argument, remove a statement - so the
operator is the intent and the site is incidental; storing the site as text is a choice, not a
requirement. And **78 of 149 (52%) have no structural scope at all**: they are a byte fragment matched
anywhere in the file, which is exactly the shape that dies first. Both failures this session were of
that shape: a statement whose inner call was inlined, and a refusal whose message text was extracted
into a `subject` expression. A third form showed up beside them: two teeth whose named case no longer
catches them (`fusion-continues-from-an-unverified-answer`, `next-is-not-the-head-of-the-ordered-candidates`
read as "caught by the suite, not the named case"), which is the same coupling one layer out - the
anchor held, the sentence "this case is the one that fails" went stale.

A measurement taken while planning this record also has to be reported, because it removed an option:
the three-way split "derivable / expressible as input / needs an internal perturbation" **does not
hold**. A targeted mutant is by definition _observable from outside_ - that is what "caught" means - so
"input-expressible" is true of all 149. The three cases predicted to need an internal perturbation all
had an external observation: the status read path opening a writable handle is observed by the store
file not changing, a second copy of the acceptance rule by a verdict whose digest does not match the
artifact, and a transaction wrapper by a plan whose third task is refused while the first two stay
frozen. So the replacement direction is not "input checks instead of mutants"; it is **derive the
mutant instead of storing it**, with input-side checks as the form for the rules where a contrast or an
enumeration already says it better.

## Proposal

**A mutant's durable part is its name, its operator, its selector and the case that must fail. The site
and the replacement bytes are computed from the syntax tree on every run.**

1. **Six operators over a named selector**, resolved inside a member: `condition-never` (the condition
   the selector identifies never holds), `condition-holds` (it always holds - the mirror, because a rule
   written as `return a && b` says the condition is true and replacing it with `false` would reverse the
   rule instead of removing it), `neutralize-term` (one term of that condition becomes its identity -
   `true` under `&&`, `false` under `||`), `replace-argument` (argument _n_ of a call becomes the
   declared fragment), `replace-property` (the value of a named object property becomes it), and
   `drop-statement` (the statement the selector identifies is removed with its line). Two rules keep
   selectors honest: a selector that matches more than one site, or a fragment that fits two candidates,
   is refused rather than guessed at; and the two whole-condition operators refuse a fragment that
   names only part of a condition, because replacing all of it would silently widen the mutant into
   "every reason this rule has" - a term has its own operator. Where a rule needs none of them, a
   `within`-scoped minimal fragment stays available, and "minimal" is the point: no message text, no
   sibling argument, no whole statement where a term does.
2. **Move the 133 G/V/R teeth to the derived form**, target by target, beginning with
   `src/integration/ooo-execution.ts` as the pilot: it holds 24 teeth over two target entries (16 fusion-
   legality and speculation, 8 session fusion), the same mutant names, the same `expect` cases, and the
   same 24 of 24 caught after conversion - 19 of them derived, 5 staying hand-written and named below -
   plus a real refactor in that file that leaves every derived site applying where a byte anchor
   retires.
   The five residues in the pilot file, each a single expression or value rather than a statement or a
   message: `selection-ignores-a-withdrawn-acceptance` (a whole `const` initializer replaced),
   `the-budget-is-not-cut-from-the-startable-set` (a returned expression's call removed),
   `next-task-is-not-the-head-of-the-legal-set` (an index `[0]` becomes `[1]`),
   `speculation-guesses-several-facts-at-once` (`length === 1` becomes `>= 1`), and
   `a-guess-with-no-evidence-publishes` (an inserted branch plus a rewritten message).
3. **What a derived form cannot express stays hand-written and says so.** The 16 I/E teeth - insertions,
   wrappers, a second copy of a rule - are the ones whose anchor is a _place where code must not
   appear_, so they are the last to move and the first to be reconsidered: where the rule already has a
   check whose form is relational or enumerative, the tooth is retired and the check is named in its
   place.
4. **A check that a tooth still applies becomes part of the static contract**: an anchors-only pass that
   resolves every mutant, without running a suite, in single-digit seconds, failing when a site cannot be
   resolved, resolves more than once, or when a target claims more teeth than it can apply. The
   `ci-and-tests` route then lists it beside the other atomic checks, and the whole-run deadline
   ([bound agent verification](../implemented/2026-09-23-verification-whole-run-deadline.md)) is a
   constraint on it: the pass is cheap, the full sweep stays out of the gate.
5. **The evidence standard is clarified, not loosened.** "How a row earns `proven`" already says a test
   that fails when the rule is broken; the clarification is that the demonstration may be a code
   perturbation (derived or hand-written) or an input-side case whose assertion contrasts two inputs or
   enumerates a bounded space. A row that used to name a tooth may name a contrast check instead, in the
   same commit that retires the tooth.

## Plan

1. This record, plus the tool's operator vocabulary and its resolver, proven by tests over source
   strings rather than by a filesystem. **Landed:** the resolver is `tools/mutation-anchor.ts` (it held
   no state, so it moved out of the sweep script and the tests can call it), with 16 cases over source
   strings and no filesystem access.
2. The pilot target converted and swept: same names, same cases, same catches; then a refactor inside it
   that demonstrates a derived tooth surviving what a byte anchor did not. **Landed**, with one
   correction: the demo first refactor was a rename plus a condition lifted into `const closed = spent ||
severalWaits`, and the prediction made before running it - one dead anchor, seven derived teeth
   surviving - was **wrong**: two sites died, the hand anchor and the derived
   `a-live-claim-does-not-block-selection`, because a condition bound to a name was not a decision
   position for the selector. Lifting a condition into a local is a refactor a maintainer makes, so the
   selector was widened to include a variable's initializer; the corrected prediction (only the hand
   anchor dies) then held exactly: `anchors: 148 of 149 resolve`, one failure, and the file restored
   byte-identically.
3. The anchors-only pass, wired into the static contract with its route and design updates. **Landed:**
   `npm run mutation:anchors` (`--anchors-only`) is one of `verify:static`'s checks and one of the
   `ci-and-tests` route's atomic checks, in the same order the route-contract test enforces. Measured
   on this revision: all 149 anchors resolve in 0.98 s inside a full `npm run agent:verify`, which is
   112 s end to end - inside its 150-second budget - and a standalone `verify:static` is 41 s. The full
   sweep stays out of the gate.
4. Retirement pass over the ~18-20 teeth whose rule already has a relational or enumerative check, and
   over the I/E teeth that can be replaced; the ledger's `proven` sentence updated in the same commit.
   **First group landed (five teeth, 2026-09-24), and the criterion is the point of it:** a tooth may go
   when a named case's assertion _fails for exactly the violation the tooth introduces_ and that case's
   wording states the rule - so the row can name the check instead of the mutant. Applied by reading the
   assertion and then re-running the target's sweep with the tooth gone.
   - `the-board-read-path-stops-calling-the-predicate` and `the-board-decides-acceptance-on-its-own`
     (row B5): the case counts the call sites itself - one definition of the predicate in `src/`, one
     `acceptedFact({` in each reader, zero `verdict ===` comparisons in `ooo-board.ts` - so both
     violations fail a count. This is the pair that made the criterion worth writing down: a
     behavioural differential would not have caught either, a count does.
   - `a-refused-unit-is-silent`: the case enumerates the 32 flag combinations a plan's facts can carry
     and asserts every refused unit has a reason.
   - `the-merge-enumerates-one-order` (row A5): the case asserts the multinomial count (10), which a
     merge returning one order fails.
   - `a-second-entry-rebinds-the-task` (row D12): the case asserts a retry is the same binding and a
     second entry is refused by name.
     Measured after the retirements: `anchors: 144 of 144 resolve` (the register is 144 teeth, not 149),
     and the four targets the pass touched sweep `70 of 70 caught`, restored byte-identically 5 of 5.
     One finding to carry forward: `a-refused-unit-is-silent` was named by **no** ledger row, and the case
     that catches it is unowned too - an orphan tooth whose retirement removed the orphan rather than a
     row's pin. **Remaining:** the rest of the ~18-20 candidates, and the I/E teeth.

## Acceptance criteria

- A mutant declared as an operator over a selector stores no byte range, and the tool resolves the site
  and the replacement from the syntax tree.
- A refactor that inlines, renames, reflows or extracts code around a derived site leaves the tooth
  applying and still caught by its named case; a byte-anchored tooth in the same place does not survive
  the same refactor (the pilot names both).
- The anchors-only pass runs without suites in under ten seconds on this tree, fails on an unresolvable
  or ambiguous site, reports the claimed-versus-applicable gap, and leaves the tree byte-identical.
- Adding it to the static contract keeps a full `agent:verify` inside its 150-second budget.
- Teeth retired in favour of a contrast or enumeration are named in the commit that retires them, and
  the row they proved names that check afterwards.
- The residue of hand-written fragments is enumerated by name, and every one of them is a single
  expression or term rather than a statement or a message.

## Risks

- **A derived selector is still scoped to a decision position.** Measured in the pilot: a condition lifted
  out of its `if` into `const closed = spent || severalWaits` retired the tooth - the selector looked for
  a condition in a decision position, and a name bound for a decision made a line later was not one
  until it was added. A tooth can therefore still die when its rule is rewritten into a _different_
  shape. The difference is that it now dies visibly: the anchors-only pass names the tooth and the
  fragment it could not resolve, which is exactly the failure that went unnoticed before.
- **A wrong selector mutates the wrong node.** A derived site is resolved by the tool, so a selector that
  matches another call can produce a mutant nobody intended. Mitigation: exactly one match or refusal,
  which the tool already does for `ast`, plus the existing two readings (a clean run must pass, and the
  named case must be the one that fails - a mutant that does not compile is reported as "by the suite,
  not the named case" rather than as a caught tooth).
- **Derivation hides the perturbation from the reader.** A reader of a `from`/`to` pair sees the change;
  a reader of `condition-never(within: judgeTaskBoardEntry, condition: existing.deliveredBy)` has to
  know the operator. Mitigation: the operators are few and fixed, they are documented beside the type,
  and the tool prints the bytes it wrote when asked.
- **Retiring a tooth can lose a named case.** A relational check may catch a class where the tooth caught
  a specific wrong behaviour, so the row would claim more than it shows. Mitigation: a retirement names
  the check that replaces it, in the ledger row and in the commit.
- **The pass could be trusted instead of run.** An anchors-only pass proves the site still resolves, not
  that the mutant is still caught; a tooth whose named case went stale still passes it. Mitigation: the
  pass reports the stale-`expect` reading the sweep already produces, and the full sweep remains the
  standing rule before a push.
- **Conversion is evidence surgery.** Every conversion touches the artifact that says the code is
  protected, so a mistake reduces coverage silently. Mitigation: one target per commit, the same names
  and cases, the catch results recorded before and after, and the post-mortem rule about a live mutant
  (status the file under test before any run).

## Alternatives considered

- **Keep hand-written anchors and make them smaller.** Rejected as the whole answer: it is a discipline,
  not a mechanism, and the discipline is what 52% of the teeth currently violate. Kept as a rule for the
  residue.
- **Anchor by AST node only, keeping byte replacements** (today's `ast.within` plus a text pair).
  Rejected as insufficient: measured, 71 of 149 teeth already have that, and two teeth died inside it
  this session, because the _replacement_ and the _fragment_ are still copies of lines.
- **Replace mutants with input-side checks wholesale.** Rejected on the measurement above: it does not
  discriminate (every caught mutant is externally observable), and it would drop the only evidence that
  speaks about an unforeseen implementation slip rather than a declared violation.
- **Insert the mutation into the code behind a runtime switch** (mutant schemata, `mutation_active("...")`
  guards). Rejected for this repository: the guard is real code in `src/`, and a switched-off mutation
  path is a policy word in the mechanism layer, which [mechanism, not
  policy](2026-09-21-mechanism-not-policy.md) forbids.
- **Auto-generate mutants from operators over the whole tree** (what PIT, StrykerJS and cargo-mutants
  do). Rejected as the form here: it would replace named evidence with a score, and the ledger needs a
  named tooth per row. The derived form keeps the operator idea and the naming.
- **Leave the sweep out of every gate and rely on the standing rule.** Rejected: the measured case for
  this record is that nobody noticed two teeth had stopped biting, and a rule that depends on being
  remembered is the shape this repository already replaced elsewhere.
