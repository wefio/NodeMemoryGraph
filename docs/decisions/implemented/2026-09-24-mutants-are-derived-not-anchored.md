# A tooth is an operator over a symbol, not a copy of a line

[中文](2026-09-24-mutants-are-derived-not-anchored.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Tests do not need a filesystem](2026-09-20-tests-need-no-filesystem.md), [The checks read a live mutant](../../postmortem/0003-checks-read-a-live-mutant.md), [Bound agent verification as one run](2026-09-23-verification-whole-run-deadline.md), [The contract's obligations](../../design/task-unit-semantics-obligations.md), [Mechanism, not policy](../proposed/2026-09-21-mechanism-not-policy.md)

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

Two readings decided this record. **89% of the teeth (133 of 149) were a site plus one of a handful of
operators** - disable a condition, drop a term, substitute an argument, remove a statement - so the
operator is the intent and the site is incidental; storing the site as text was a choice, not a
requirement. And **78 of 149 (52%) had no structural scope at all**: a byte fragment matched anywhere in
the file, which is exactly the shape that dies first. Both failures observed while planning were of that
shape: a statement whose inner call was inlined, and a refusal whose message text was extracted into a
`subject` expression. A third form showed up beside them: two teeth whose named case no longer caught
them (`fusion-continues-from-an-unverified-answer`, `next-is-not-the-head-of-the-ordered-candidates` read
as "caught by the suite, not the named case"), which is the same coupling one layer out - the anchor
held, the sentence "this case is the one that fails" went stale.

A measurement taken while planning also had to be reported, because it removed an option: the three-way
split "derivable / expressible as input / needs an internal perturbation" **does not hold**. A targeted
mutant is by definition _observable from outside_ - that is what "caught" means - so
"input-expressible" was true of all 149. The three cases predicted to need an internal perturbation all
had an external observation: the status read path opening a writable handle is observed by the store
file not changing, a second copy of the acceptance rule by a verdict whose digest does not match the
artifact, and a transaction wrapper by a plan whose third task is refused while the first two stay
frozen. So the replacement direction was not "input checks instead of mutants" but **derive the mutant
instead of storing it**.

## Decision

**A mutant's durable part is its name, its operator, its selector and the case that must fail. The site
and the replacement bytes are computed from the syntax tree on every run.**

- **The operator is the mutation class; the selector is the site.** A tooth says
  `condition-never(within: judgeTaskBoardEntry, condition: existing.deliveredBy)`, not two lines of
  source. The tool resolves the range and writes the bytes, so a rename, a reflow or a lifted statement
  leaves the tooth aimed at the same rule, and every replacement is computed rather than stored - `to`
  exists only where the new value is a _choice_ (a different argument, property, initializer, iterable,
  index, callee or literal fragment).
- **The vocabulary is the one the catalogues name**, not one invented here: pitest's
  `NEGATE_CONDITIONALS`, `REMOVE_CONDITIONALS`, `VOID_METHOD_CALLS`, `PRIMITIVE_RETURNS`;
  Stryker's `ConditionalExpression`, `EqualityOperator`, `ArrayDeclaration`, `MethodExpression`,
  `BlockRemoval`; cargo-mutants' patterns. A site with no operator behind it is a **missing operator**,
  not a permanent hand-written anchor - that is what turned the last residue of 15 into the last three
  operators plus three widenings.
- **A selector that is ambiguous is refused, never guessed at**: more than one matching member, call,
  property, statement, comparison, literal or element access is a failure, and so is a fragment that
  names only part of a condition the operator replaces whole (a term has its own operator).
- **Scope is named; module level is a scope too.** A selector is normally scoped to one member - a
  method, a function declaration, a class constructor under the name `constructor`, or a function bound
  to a variable or to an object property. Where there is no member, `within` is omitted and the whole
  file is the scope, with the selector required to be unique in it.
- **The anchors pass is part of the static contract.** `npm run mutation:anchors` (`--anchors-only`)
  resolves every tooth without running a suite, and is one of `verify:static`'s checks and one of the
  `ci-and-tests` route's atomic checks. The full sweep stays out of the gate and remains the standing
  rule before a push, because the pass proves a site still resolves, not that the mutant is still
  caught.
- **The evidence standard is clarified, not loosened.** "How a row earns `proven`" already requires a
  test that fails when the rule is broken; the clarification is that the demonstration may be a code
  perturbation (derived or hand-written) or an input-side case whose assertion contrasts two inputs or
  enumerates a bounded space. A row that used to name a tooth may name a contrast check instead, in the
  same commit that retires the tooth.
- **A tooth may be retired when a check states its rule.** The criterion: the sweep first shows the
  tooth's named case is the one that fails under it, **and** reading that case's assertion shows it fails
  for exactly this violation and states the rule - a count, an enumeration, a relation read back as a
  raw row, or a refusal by name. A behavioural differential does not qualify. Two things that look like
  witnesses and are not: a fixture derived from the constant under test, and a case that refuses for a
  second reason as well.

## Implementation state

**The register is 110 teeth over 22 target entries covering 21 files, every one of them a name plus an
operator plus a selector, with no hand-written anchor left. 26 operators. 37 teeth have been retired in
favour of checks that state their rule.**

`tools/mutation-anchor.ts` holds the resolver: `Mutant`, `Derive`, `Site`, `matchText`, `locate`, and a
table of resolvers, one per operator, so adding an operator is an entry in that table plus its name in
the type union. It holds no state and reads no file, so the sweep and the anchors-only pass ask the same
function the same question and `tests/tools/mutation-anchor.test.ts` proves it over source strings - 35
cases, one per operator plus every refusal, with no filesystem access. Where the mutation determines its
own bytes (`false`, `true`, the negated operator, the call's receiver, the guard's body, the empty
collection) nothing is stored.

| operator                                                      | what the catalogues call it                                                 | teeth      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| `condition-never`, `condition-holds`                          | pitest `FALSE_RETURNS` / `TRUE_RETURNS`; Stryker `ConditionalExpression`    | 45 + 3     |
| `neutralize-term`                                             | pitest `NEGATE_CONDITIONALS`; Stryker logical/boolean literals              | 9          |
| `negate-condition`                                            | pitest `NEGATE_CONDITIONALS`; Stryker boolean literals                      | 2          |
| `negate-comparison`                                           | pitest `NEGATE_CONDITIONALS`; Stryker `EqualityOperator`                    | 3          |
| `remove-conditionals`                                         | pitest `REMOVE_CONDITIONALS`                                                | 1          |
| `drop-statement`                                              | Stryker `BlockRemoval`; pitest `VOID_METHOD_CALLS`                          | 8          |
| `remove-call`                                                 | Stryker filter/slice/sort removals; pitest `VOID_METHOD_CALLS`              | 2          |
| `replace-call`                                                | Stryker `MethodExpression`; pitest `CONSTRUCTOR_CALLS`                      | 4          |
| `replace-argument`, `replace-property`, `replace-initializer` | pitest `PRIMITIVE_RETURNS`, `INLINE_CONSTS`; Stryker's literal mutators     | 8 + 10 + 7 |
| `replace-iterable`                                            | Stryker `ArrayDeclaration`; pitest `EMPTY_RETURNS`                          | 3          |
| `replace-index`                                               | (no catalogue entry; the nearest, `FirstToLast`, is a method named `first`) | 2          |
| `replace-literal-fragment`                                    | SQLMutation's clause-level operators, at fragment granularity               | 3          |

Three waves converted the register, each swept after it: 59 teeth with the six operators the resolver
started with, 18 with the seven the catalogues name, and the last 15 with three more operators and three
widenings. The widenings were all found by real teeth failing to convert, never by argument:

| what the residue needed      | what was added                                                                                                    | teeth |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| a function bound to a name   | `uniqueMember` accepts a function bound to a variable or to an object property (`claim: (store) => ...`)          | 2     |
| two identical call sites     | `in` names a fragment of the statement a call or a literal sits in                                                | 3     |
| module level                 | `within` is optional: the file is the scope, the selector must be unique in it                                    | 2     |
| a constructor call           | the call selectors accept `new X(...)` as a call site                                                             | 1     |
| a shorthand property         | `replace-property` writes it out (`position` becomes `position: 0`), because a value cannot go where the name was | 1     |
| an index, a literal fragment | `replace-index`, `replace-literal-fragment`                                                                       | 5     |

**Readings, at this revision:** `anchors: 110 of 110 resolve, over 22 targets`; `mutants: 110 of 110
caught by the named test`, **all 110 by the case their `expect` names**, 22 of 22 targets restored
byte-identically, exit 0 in 162 s; `tests/tools/mutation-anchor.test.ts` 35 pass; `test:product` 1580
pass; `verify:static` exit 0; lint 0 findings; complexity gate ok. The run that added the misnamed check
reads exactly the same, which is also what says the check raises no false alarm across the whole
register. An earlier full-run reading on the same arc: 136 teeth, 136 of 136 caught, all 136 by name,
217 s.

**Corrections this record carries, each caught by a run rather than by review:**

- The pilot's refactor prediction was wrong: a condition lifted into `const closed = spent ||
severalWaits` retired a derived tooth as well as the hand anchor, because a condition bound to a name
  was not a decision position for the selector. The selector was widened to include a variable's
  initializer, and the corrected prediction then held exactly.
- The first whole-register sweep said 136 of 136 caught but only **134 by the case each `expect` named**.
  Four links were wrong: a case that refused the pair for a second reason as well; an `expect` naming a
  case in another target; an `expect` that was a paraphrase naming no case; and a named case whose
  fixture was derived from the constant under test (`half = CLOCK_GRACE_MS / 2000`), so zeroing the
  constant moved the stamp and the case passed while the bug was live.
- A wrong `within` was shipped twice. The quiet one: `the-completion-ignores-a-cancelled-unit` aimed at
  `checkDispatch` instead of `checkCompletion` - the anchors pass resolved, the mutant was caught, but by
  the _suite_ rather than by the case that names a completion of a cancelled unit. The loud one: a guard
  aimed at `instrumentCommit` instead of `runParentCheck`, refused immediately as "0 guards in
  instrumentCommit match the selector". **A wrong member is loud when it finds nothing and silent when it
  finds the same shape twice**, which is why the sweep after a conversion is not optional.
- Three reasons recorded for _not_ converting the last 15 were measured wrong: the catalogue's negation
  (`=== 1` to `!== 1`) does realise the violation the name states; `every-task-is-frozen-at-position-zero`
  changes only one load-bearing thing, because `noUnusedParameters` is not set; and the two teeth that
  "shared a line" were only ever hand anchors that had to span two statements - the mutations are single
  statement removals. The lesson kept: attempt every site with the operators available and measure,
  before writing down a reason not to.
- A hand-typed `expect` reads as a broken mutant. Retyping two case names from memory instead of copying
  them made both teeth report **"survived"**: the tool filters the suite by the named case, so a name
  that matches no case is indistinguishable from a mutant nothing catches. It is a loud failure, never a
  false pass, and it is the second time this register has been bitten by `expect` being an assertion of
  its own. Conversion scripts now copy the string from the register.
- Rerunning a conversion script after the vocabulary had grown rewrote two teeth back to their earlier
  form; the anchors pass refused both at once. That is the case for the pass being in the static
  contract seen from the other side: it also catches edits to the register, not only drift in the code it
  points at.

**Retirements.** 37 teeth went, in four groups, each only after the sweep showed the named case was the
one that failed under it and the case's assertion was read. Eleven in the first two groups (the two
call-site counts behind row B5, the 32-combination enumeration, the multinomial count of 10 behind row
A5, a rebinding refused by name, and the five rules of the declared budget stated by one case). Two in
the third (row D11, whose prose already rested on the cases). 26 in the fourth: the insertion-shaped
teeth, whose anchor is a place where code must not appear, and which a derived selector cannot express -
the only honest alternatives were a permanent fragile anchor or a check that states the rule. One of that
set was kept and then converted, and seven named no ledger row at all: the rules were real, but no row
mentioned them. Each of the seven was given a home in the row that already carries its rule rather than a
row invented for it - two rows extended, one row added ([the ledger](../../design/task-unit-semantics-obligations.md)).

**What is not claimed.** A derived tooth is not stronger evidence than the byte anchor it replaced: it is
the same violation, caught by the same case. What it buys is that the tooth stays aimed at its rule
across renames and reflows, which is the failure this record exists for. The operators are not the whole
catalogue either - they are the classes this register's rules happen to need. And a conversion is not a
licence to stop sweeping: `mutation:anchors` proves resolution, not a live catch.

**What the catalogues say, kept deliberately.** pitest's _Less is more_ names the effect the retirement
criterion measures: a mutant the combination of others already subsumes adds runtime, not confidence.
pitest avoids them with a fixed default set; this register measures it. cargo-mutants counts a mutant
that does not compile separately and documents why it refuses some mutations (`==` to `<` "too prone to
generate false positives", `-a` to `+a` "too prone to generate unviable cases") - the same argument used
here for not adding operators for shapes that are rare. The one thing this design does not borrow is the
definition of a kill: those tools count a mutant killed when _any_ test fails; here a tooth is counted
only when **the case it names** is the one that fails, which is why "caught by the suite, not by the case
that names the rule" is a defect this register reports and none of those tools would.

## Alternatives considered

- **Keep hand-written anchors and make them smaller.** Rejected as the whole answer: it is a discipline,
  not a mechanism, and the discipline is what 52% of the teeth violated. It survives as a rule for the
  replacement bytes, which stay minimal on purpose: no message text, no sibling argument, no whole
  statement where a term does.
- **Anchor by AST node only, keeping byte replacements** (the older `ast.within` plus a text pair).
  Rejected as insufficient: measured, 71 of 149 teeth already had that, and two teeth died inside it,
  because the _replacement_ and the _fragment_ were still copies of lines.
- **Replace mutants with input-side checks wholesale.** Rejected on the measurement above: it does not
  discriminate (every caught mutant is externally observable), and it would drop the only evidence that
  speaks about an unforeseen implementation slip rather than a declared violation.
- **Insert the mutation into the code behind a runtime switch** (mutant schemata, `mutation_active("...")`
  guards). Rejected for this repository: the guard is real code in `src/`, and a switched-off mutation
  path is a policy word in the mechanism layer, which [mechanism, not
  policy](../proposed/2026-09-21-mechanism-not-policy.md) forbids.
- **Auto-generate mutants from operators over the whole tree** (what pitest, StrykerJS and cargo-mutants
  do). Rejected as the form here: it would replace named evidence with a score, and the ledger needs a
  named tooth per row. The derived form keeps the operator idea and the naming.
- **Leave the sweep out of every gate and rely on the standing rule.** Rejected: the measured case for
  this record is that nobody noticed two teeth had stopped biting, and a rule that depends on being
  remembered is the shape this repository already replaced elsewhere.

## Consequences

- **The register's cost is now a vocabulary rather than a maintenance duty.** A reader of a `from`/`to`
  pair sees the change; a reader of `condition-never(within: judgeTaskBoardEntry, condition:
existing.deliveredBy)` has to know the operator. Mitigation: the operators are few and fixed, each one
  is documented beside its type with the catalogue it comes from and the selector it needs, and the tool
  prints the bytes it wrote when asked.
- **A derived selector is still scoped to a decision position, so a rule rewritten into a different shape
  can still retire its tooth.** The difference is that it now dies visibly: the anchors pass names the
  tooth and the fragment it could not resolve, which is exactly the failure that went unnoticed before.
- **A wrong selector mutates the wrong node, and a mutant that does not compile is not a caught tooth.**
  Mitigation: exactly one match or refusal, plus the two readings the sweep already takes (a clean run
  must pass, and the named case must be the one that fails - a mutant that only breaks the build is
  reported as caught by the suite, not by the named case).
- **Retiring a tooth can lose a named case.** A relational check may catch a class where the tooth caught
  a specific wrong behaviour, so a row could claim more than it shows. Mitigation: a retirement names the
  check that replaces it, in the ledger row and in the commit that retires the tooth.
- **A conversion is evidence surgery.** Every conversion touches the artifact that says the code is
  protected, so a mistake reduces coverage quietly. Mitigation: one target at a time, the same names and
  cases, the catch results recorded before and after, and the post-mortem rule about a live mutant
  (status the file under test before any run).
- **The pass can be trusted instead of run.** An anchors-only pass proves the site still resolves, not
  that the mutant is still caught, and a tooth whose `expect` went stale still passes it. Mitigation: the
  full sweep remains the standing rule before a push, and the sweep is the reading that counts - not the
  number of teeth, but **the number of teeth whose named case is the one that fails**.
- **The `expect` field's own failure mode is answered.** It was loud but ambiguous: a name no case
  carries made the filtered run pass with no case in it, and that pass was reported as a surviving
  mutant - which is how two teeth were read as broken while they were only misnamed. `ranACase` reads the
  run's own report before believing a pass: a marked line that is not the suite file is a case, a suite
  line alone means the filter matched nothing, and an unrecognized reporter answers unknown rather than
  accusing a tooth. A misnamed tooth is reported as `misnamed` with the name it wanted, it is a problem
  with a non-zero exit, and the whole-suite fallback is not run for it - the defect is the name, not the
  coverage.
- **The seven rules no row named are placed, not left dangling.** When the insertion-shaped teeth were
  retired, seven of them named a rule no row claimed: a publication joining the caller's transition, a
  round releasing the pins it held, the ordered mode being the declared plan order, the batch's units in
  flight together, a unit with no checks refused, the parent check reporting its composed verdict. Each was
  given a home in the row that already carries its rule - B3 gained the publication case (its own suite),
  B4 the pin release, the ordered mode became its own row (A6, the design's own sentence about publication
  order, which had no row), and the four judge-loop rules are F2b-slot's and F2c's, whose texts now name
  the cases. What remains open is only whether a rule with a check but no row is a defect at all: it was
  one here, but the defect was in the ledger, not in the register.
