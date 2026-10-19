# What landed with this document

[简体中文](implementation-artifacts.zh-CN.md) · [Terms used](implementation-artifacts.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../mechanism-in-the-middle.md).

## What landed with this document

- **The read face has one home.** `src/core/board-entry-view.ts` owns the rule: a lone `memory=<id>` pointer
  is returned whole, anything longer is collapsed to one bounded line, and the bound belongs to the caller,
  because how much of a body fits is the reader's decision. The store's compact read and the host adapter's
  broadcast both call it; the store's private copy and the adapter's bare slice are gone. One of the three
  rules was also wrong rather than merely duplicated: the 140-character slice in `.pi/extensions/nmg/index.ts`
  did not collapse whitespace, so a multi-line body reached a broadcast as a multi-line broadcast.
  `tests/core/task-board.test.ts` pins the rule directly. The adapter's `excerpt` helper stays for memory
  results, which are not board entries and keep their own rule.
- **The write face's type did not land.** The three fillers are three kinds of entry rather than one shape
  drawn three ways, so the trigger for a type is a fourth filler. Measured again here: the _artifact_ body
  inside a result already has a home (`artifactEnvelope` and `artifactFromText` in
  `src/integration/ooo-session-mechanism.ts`, which is why the worker's tool and its text channel obey one
  contract), while the _entry_ body that wraps it has one writer and two readers that are two different
  rules - the probe parses the loop's envelope and binds a verdict to the ticket's digest, and the product
  board reads the artifact of a body that may be the artifact itself, because an agent that delivers through
  the board tool writes the bytes it produced. Two rules with one implementation each are not a seam.
- **The identity of work has one home.** `src/integration/work-identity.ts` owns the rule a verdict binds
  to: sha256, hex, full length, over exactly the bytes or the JSON text the caller froze. Four modules had
  written the same two lines - twice as an identical private `digestOf(value)` - and two of those callers
  had folded their own shortening into it, so a twelve-character report identity and a sixteen-character
  branch identity read as part of the rule instead of a caller's choice. Canonicalisation stays the caller's
  and the module says so: JSON key order is whatever the caller built, which is why freezing a patch is what
  makes its digest stable. Two named mutants make the convention checkable - another encoding, and a JSON
  variant that does not digest JSON. Sites that differ on purpose (a base64url search content hash, a
  session id, a protocol-visible `sha256:` prefix) keep their own convention, and the module names them, so
  a later sweep cannot unify three different rules.
- **The middle's seam did not land.** Check (c) says why.
- **The port has a third implementation, and it is the product's.** `src/integration/ooo-runner.ts` is the
  store's own board: it projects the run's frozen table and its board entries into the facts the shared
  rules read, and it carries no legality rule of its own. Three implementations satisfy `DispatchBoard` now
  - the probe board, the dispatch test's stub, and this one - and only the projection differs between them,
    which is the abstraction working rather than a claim that it does.
- **The port's read answers why, not only which.** `legality()` is that read: the ordered legal set, the
  room the run has left, and a named cause for every unit the rules do not have on offer. The causes are
  computed inside the rules' own `selection`, so a cause names a gate rather than restating its condition,
  and a plan-level gate is attached to the units it holds back; `candidates()` is that answer's `legal`, so
  the two cannot disagree. The answer names nobody - who claimed, delivered or judged stays a board fact -
  and asking changes nothing: no entry, no claim, no budget, no wake.
- **Who can be asked.** The process that owns the run's workspace, through its board. A plan is compiled
  from the caller's files and the daemon holds only their frozen paths, so this read cannot be answered from
  the store alone; that is a property of where the plan lives, not a surface the daemon is missing.
- **The projection has one contract that is easy to get wrong.** The shared acceptance rule binds a verdict
  to the artifact a run carries: it compares the verdict's digest against the artifact value, so a verdict
  about a different artifact cannot pass as acceptance. Reporting the store's own deliverable hash in that
  field instead makes every accepted unit read as unaccepted, and the symptom is silent - the next unit is
  never released and nothing reports an error. Both identities are legitimate; only the artifact value
  belongs in that field.
- **Where the port's verbs meet the product's lifecycle.** A product run keeps a deliverable on the entry a
  unit was claimed on, so the port's "put a result" is that delivery and its "submit" is the judgement of
  it: one entry per unit, not two, because a second result entry would be a record nothing reads. The unit
  is resolved from the claim the loop has just taken rather than from the body, because a body's shape
  belongs to its owner while a claim is the board's own fact.
