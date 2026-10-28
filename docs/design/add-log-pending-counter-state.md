# The pending counter: states, transitions and invariants

**Status:** draft
**Created:** 2026-10-28

Part of [Add as an immutable log entry](add-append-log-and-fold-design.md), which owns
the design. This page owns one component: `manifest.pending`, the count that decides
whether a search has to look at the log and whether a request has to fold.

## Why this needs a table

The log path shipped with the counter as an increment-and-hope value. Four review
rounds found six defects in it, every one in the same component and every one a
transition nobody had written down:

| defect                                                   | shape                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| fold iterated `{name, entry}` as strings                 | entry never applied, nothing deleted                       |
| counter decremented by applied entries only              | receipt-present and cross-generation entries never retired |
| `Object.assign(manifest, withPending(m, 0))`             | the zero case never reached the manifest                   |
| delete failure while the counter was already decremented | the same batch subtracted twice                            |
| entry written before the counter was committed           | an entry no counter accounted for, hidden from search      |
| a throwing write treated as "did not land"               | a reservation released for an entry on disk                |

None of these is subtle once the states are on paper. That is the point of this page.

## States

`pending` and the log are two observations of one thing, so states are pairs:

| state                  | `manifest.pending` | log                              | reachable by                           |
| ---------------------- | ------------------ | -------------------------------- | -------------------------------------- |
| **C** clean            | absent             | empty                            | every path converges here              |
| **P** productive       | `n > 0`            | `m` entries, `n >= m`            | accepts outrunning folds               |
| **D** draining         | `n > 0`            | `m` entries being folded         | a fold in flight                       |
| **R** residue-high     | `n > 0`            | empty                            | a reservation whose write never landed |
| **G** stale-generation | `n > 0`            | entries from an older generation | reset racing a fold                    |

There is deliberately no "residue-low" state (`pending` absent, log non-empty). It was
reachable when the entry was written before the counter; reserving first makes it
impossible, which is the reason for that ordering. **Seeing it means a bug**, not a
state: a search would skip the log and hide data.

## Transitions

`E` is the set of readable entries under the current generation; `pending` is the
stored count. Every row states what the transition must leave behind.

| from         | event                                     | to        | must leave                                                                    |
| ------------ | ----------------------------------------- | --------- | ----------------------------------------------------------------------------- |
| C            | accept                                    | P         | counter committed **before** the entry is durable (`acceptAdd`)               |
| P/D          | accept                                    | P/D       | counter +1, reservation recorded (`acceptAdd`)                                |
| P (reserved) | write fails, `logEntryLanded` = **true**  | P         | entry exists, so answer success (`acceptAdd`)                                 |
| P (reserved) | write fails, `logEntryLanded` = **false** | P         | counter −1 (`releasePending`)                                                 |
| P (reserved) | write fails, `logEntryLanded` = **null**  | P         | counter untouched, error surfaced                                             |
| P/D          | fold applies an entry                     | D         | receipt written in the same partition commit                                  |
| D            | fold absorbs a batch                      | P/C       | retire `S` = applied ∪ receipt-present ∪ cross-generation; counter −          | S   | ; delete `S` **after** commit |
| D            | delete fails                              | P         | counter re-read from the log (`reconcilePending`), never by subtraction again |
| R            | any fold or drain pass                    | C         | counter −1 per pass (`releasePending`), reported as progress                  |
| C/R          | drain pass with counter 0                 | C         | no write, no CAS                                                              |
| G            | fold                                      | C         | cross-generation entries retire with the batch, are never applied             |
| G            | search                                    | G         | entries from another generation are filtered out (`pendingForSearch`)         |
| any          | reset                                     | C         | generation barrier first, then `clearLog` (I4)                                |
| any          | capacity read                             | unchanged | reports the counter, writes nothing                                           |

## Cross-generation shadowing (state G plus a zero count)

State **G** is only safe while the count is above zero. Two independent mechanisms
break that, and fixing either alone is not enough:

- **The read window.** A filtered list must be filtered _while reading_. Listing keys
  first and filtering after truncation lets a handful of entries from the old
  generation consume the whole window, so `pendingForSearch` returns nothing while
  current entries sit in the log. `listPending` therefore lists every key when a
  `generation` is given (and stays bounded when it is not).
- **The reset hand-off.** The empty manifest a reset commits used to drop `pending`,
  so after a failed log cleanup the surviving stale entries had **objects but no
  count**. A fold then retired and subtracted them - entries that were never added to
  the count - driving it to zero, where the short-circuit hides everything accepted
  after the reset. The reset now carries the count forward and zeroes it only after
  `clearLog` succeeded, guarded by the count not having moved so it cannot eat a
  concurrent reservation.

With only the first fix the count still drifts to zero; with only the second the read
window is still starved. The table's T1 is what both are serving: the count may never
fall below what the current generation can read.

## Invariants

- **T1 — never below the truth.** `manifest.pending >= |readable entries|` at every
  commit. The reverse hides an accepted entry from every search, because
  `pendingForSearch` short-circuits on a zero count.
- **T2 — every over-count has a path back.** Over-count is the safe direction but not
  a terminal state: a failed write releases (`releasePending`), a failed delete
  re-reads (`reconcilePending`), and a drain releases one slot per pass (`foldPending`
  empty-log branch). Without T2 an over-count below `FOLD_TRIGGER` has no trigger that
  would ever notice it.
- **T3 — bounded convergence.** Repeated `POST /admin/fold` reaches `C` in
  `ceil(pending / FOLD_BATCH) + 1` calls, and answers 409 for every call before the
  last one.
- **T4 — absence means zero.** `pending` is deleted, never stored as 0; the format is
  v4 only while an entry is pending, so a drained store is byte-identical to one that
  never had a log.
- **T5 — idempotency is carried by names, not counts.** Replaying an accept is guarded
  by the entry name and the receipt, never by the counter, so a wrong count can cost a
  listing but cannot duplicate a write.

Every transition above names the function that performs it, and every invariant names
the assertion that fails when it is broken:

| invariant | enforced by                                             | failing assertion                                   |
| --------- | ------------------------------------------------------- | --------------------------------------------------- |
| T1        | reserve-before-write, three-state landed check          | `an accepted but unfolded entry must be searchable` |
| T2        | `releasePending`, `reconcilePending`, empty-log release | `a single residue slot must report clean`           |
| T3        | `foldRoute` 8-round bound + 409                         | `one slot is left after a full pass`                |
| T4        | `setPending` deletes at zero; `manifestFormat`          | byte-identity test in `test-manifest-pending.mjs`   |
| T5        | entry name + receipt                                    | `replay must survive folding`                       |

## What this table does not cover

- **A physically failing write.** The three-state answer is tested with a fake bucket;
  the condition that selects it (an object PUT throwing on a real store) is not
  exercised end to end.
- **Concurrent folds on one user.** Manifest CAS serializes them, so the table assumes
  one commit at a time; a lost CAS re-runs the transition from the top, which the
  table relies on rather than proves.
- **A count corrupted outside this code.** `loadManifest` rejects a non-integer count
  as `storage_corrupt`; anything else writable by hand is out of scope.
