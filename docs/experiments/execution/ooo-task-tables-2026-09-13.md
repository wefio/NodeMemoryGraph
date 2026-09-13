# A task row's three kinds of fact, split into three tables — 2026-09-13

The design's persistence section (`docs/design/task-unit-semantics.md:200-208`) says a persisted
fact may be one of two kinds — the immutable run manifest, or an append-only run fact the board does
not have — and that **derived state has no authoritative storage**: `ready`/`blocked`/`accepted`,
dependency satisfaction, validity after cancellation and fusion candidates are computed. One row in
`ooo_probe_tasks` held all three at once, which is why the previous migration had to _decide_ not to
trust an old `accepted_entry_id` column, and why "the derived value can be rebuilt" was an assertion
rather than a test.

## The shapes

- `ooo_probe_manifest (run_id, id, revision, input, dependencies, position, effect,
source_revision, wait_event, operation, kind, patch_files, patch_editable)` — written once when the
  plan is installed, never updated afterwards.
- `ooo_probe_facts (…, attempt, artifact, entry_id, external_ready, observed_revision, owner,
claim_time)` — what the round appended and the board does not carry.
- `ooo_probe_derived (…, input_digest)` — one column, because one thing is recomputable here.
- `ooo_probe_task_view` — a projection (manifest ⋈ facts ⋈ cache), not storage. Reads use it, so a
  missing cache row degrades to the manifest's own answer instead of a lost fact.

## What the recomputation check found

The first version of the split put `owner` and `claim_time` in the cache, on the reasoning that the
board knows who holds a claim. Deleting the cache and rebuilding made that **wrong**: the round
resolves the entry when it accepts the artifact, and after that the board stops reporting
`claimedBy`, so a rebuild re-derived `null` where the cache had held the reviewer's name. Who claimed
is therefore a fact — it is what happened, and it is not still readable from the source — and it
moved to `ooo_probe_facts`. This is the kind of thing the design's check exists to catch: the split
looked right in the schema and was wrong in the sources.

What remains in the cache is genuinely recomputable: `input_digest`, from the frozen manifest alone
(the ticket that mints it on a claim could be lost with the round's memory and rebuilt from the
manifest's bytes). The test deletes the whole cache, rebuilds it, compares the rebuilt values, and
then **delivers the next task in the round** — a rebuilt digest that were merely equal but unusable
would pass the comparison and fail the delivery.

## Evidence (re-runnable)

- `npm test` — **1455 passed, 0 failed** (product, includes the 3 new tests).
- `tests/integration/ooo-task-tables.test.ts` — **3 of 3**: a claim writes the facts and the cache but
  touches no manifest byte; deleting the cache and rebuilding yields the same cache and a usable
  round; corrupting the cache is repaired by the sources rather than trusted.
- `tests/integration/ooo-run-namespace.test.ts` — **4 of 4** unchanged (a pre-namespace store still
  migrates, now straight into the three tables).
- `node --experimental-strip-types --test "evals/ooo-execution/*.test.ts"` — **88 passed, 0 failed**
  (the round suites, including replay).
- `npm run mutation:teeth` — **23 of 23 mutants caught by name across 6 targets, 6 of 6 restored
  byte-identically, 0 inapplicable** (the rebuild tooth was added here; the claim tooth moved with
  the statement it pins).
- `npm run docs:check`, `npm run complexity:gate`, `npm run check` — clean.

Two mechanical notes, because they cost real time and will recur: a raw SQL anchor that crossed a
method boundary silently deleted `transaction()` and `ensureColumns()` (found by `npm run check`,
not by reading the diff), and a mutation marker must be copied from the file's bytes — prettier
rewrapped the line this tooth targets, so a hand-typed marker matched nothing until it was retaken.

## What this does not do

- **The round still opens its own SQLite file.** Composing the daemon-owned store is the next step,
  and the namespace plus this split are what make it a change of owner rather than a rewrite.
- **Facts are keyed by `(run_id, id)`, not append-only by sequence.** The attempt counter and the
  latest candidate are facts; earlier attempts are not separately retained. The design's
  `runFactsThroughSequence` view would want them, and the split is the place that would hold them.
- **The run-level manifest is still `ooo_probe_runs`** (policy, cancellation). It is immutable in
  practice, but it is not yet expressed in the manifest's terms.
