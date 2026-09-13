# The complexity gate measures a diff in two linter runs, and keeps the source extension

[中文](2026-09-13-complexity-gate-batched-probes.zh-CN.md)

**Status:** implemented  
**Approved:** explicit

## Problem

`complexity:gate` spawned one ESLint process per changed code file, **per side** —
once for the working tree and once for the same file at the baseline. Process start
costs about 0.8 s, so a worktree with 64 changed code files spent **97 s** in a
single check. Measured on 2026-09-13: every other static check ran in 0.9–7.0 s
(`lint` 4.2, `format:check` 3.6, `check` 7.0, `package:check` 5.9). The gate was the
reason a verification round felt like minutes.

Measuring that cost exposed a second defect that mattered more than the time.
[The probe name was derived by
`filePath.endsWith(".ts") ? ".ts" : ".js"`](../../../tools/complexity-gate.ts) — and
`.mts` does not end in `.ts`. An `.mts` source was therefore written to a `.js`
probe, ESLint parsed it as JavaScript, answered
`Parsing error: ',' expected.`, and the gate reported the file under "could not
measure". `scripts/verify-docs.mts` was never complexity-checked, on either side.

The report did not look wrong: it is the honest unmeasured-file notice the gate was
rebuilt to print. Repairing the extension showed what it had hidden — three
violations in that one file, two of them written earlier the same day
(`checkPostmortemRecord` 17, `checkPostmortems` 17, and `verifyDocumentation` grown
41 → 45). A gate that cannot see the file the documentation check lives in is a
blind spot, not a policy.

## Decision

Two changes to one measurement path, in
[`tools/complexity-gate.ts`](../../../tools/complexity-gate.ts):

- **Many sources per linter run.** `complexitiesForMany` writes every probe and
  measures them in as few ESLint runs as the command line allows, grouped by
  accumulated path length because Windows bounds the argument list. ESLint already
  reports per file, so the per-file verdict is unchanged. `complexitiesFor(file,
source)` remains as the single-source wrapper for callers and tests.
- **The probe keeps the source's extension** (`probeExtension`), so the parser and
  module kind the linter selects always match the file being measured.
- **Probes live in a gitignored scratch directory** (`.nmg/complexity-probes/`), and
  the entry point removes its own files on `SIGINT`/`SIGTERM`.

Unchanged: which revision the baseline is, the sentence that states it, the naming
of files it could not measure, and the diff-aware verdict. Batching moves no
verdict: every failure mode it adds — a spawn that produces nothing, stdout that
will not parse, a report entry ESLint never emitted, a fatal parse error in one file
of a batch — resolves to "not measured", which the gate prints, and never to
"measured and clean".

The three violations the repaired measurement found in
[`scripts/verify-docs.mts`](../../../scripts/verify-docs.mts) are fixed in the same
change — the post-mortem header scan, numbering, and index checks move into their
own functions, and the decision-file counters move out of `verifyDocumentation` —
so this change's own gate run is clean.

## Alternatives considered

**Keep one process per file and parallelize across workers.** Still one process
start per file; wall time drops to N/cores while the gate competes with the rest of
the route for CPU. ESLint's per-file JSON report made the process count the wrong
variable to optimize.

**Cache complexity by content hash.** A second source of truth about what was
measured, plus the invalidation question ("did the config change?") that this gate's
honesty section exists to keep out. Batching removes the need.

**Lint the real files for the current side and use probes only for the baseline.**
Faster still, and tempting because the baseline has no file on disk. Rejected: the
two sides would then travel different paths, and a parser difference between them
would surface as a complexity difference — the exact kind of false verdict this gate
must not produce.

**Treat `.mts` as out of scope instead of fixing the extension.** That converts a
blind spot into a documented exemption, and `.mts` is where the documentation
verifier itself lives.

**Fix only the extension and keep the per-file spawns.** Correct, but leaves the
97 s. Both defects live in one measurement path, and the file that exposed the blind
spot is also the one that showed the cost.

## Verification

- Old against new on the same 64-file worktree: **identical** verdicts, line for
  line, except that the two `could not measure scripts/verify-docs.mts` lines are
  gone — `scripts/verify-docs.mts` is now measured, and clean after the refactor
  above.
- `npm run complexity:gate` on that worktree: 97 s → 8–10 s, with the remaining 13
  violations all in files another workstream has open.
- Three regression tests, each pinning a property that had none:
  `a probe keeps the source extension, so a .mts file is measured`;
  `one unparseable file in a batch leaves the others' verdicts alone`; and
  `probes are written where git cannot see them`, which asserts both the scratch
  location and that `changedFiles` does not return a probe. All in
  [`tests/tools/complexity-gate-base.test.ts`](../../../tests/tools/complexity-gate-base.test.ts).
- The four existing honesty tests still pass: baseline selection, the stated basis,
  a measured file above the cap, and a file the linter cannot parse.
- `npm run docs:check` reports zero errors and zero warnings, and the post-mortem
  tier's own complexity is now within the cap.

## Consequences

- The remaining 8–10 s is 66 `git show` calls reading the baseline (3.6 s), two
  ESLint runs, and process start. The cost is now roughly linear in the diff size
  through `git show`, not through process creation.
- Probes are many and simultaneous now, so an interrupted run leaves more scratch
  than before: a console interrupt is cleaned by the entry point's handler, a hard
  kill is not, and neither is assumed. The scratch directory is gitignored so a
  leftover is inert — measured directly: an interrupted run of the previous form
  left 42 probe files in the repository root, every one of them visible to
  `git status`, which is how the next run would have counted the gate's own litter
  as changed code files.
- Extension fidelity is a behavior change: a changed `.mts`, `.mjs`, `.cts`,
  `.cjs`, `.jsx`, or `.tsx` file is measured where it could previously be reported
  as unmeasured. Newly visible violations are the intended outcome — this record's
  own change produced three, in code written the day before.
- A diff whose probe paths exceed the argument budget costs one extra linter run
  per 6 KB of paths, which is a bounded cost rather than a per-file one.
- `.mts` files were unmeasured for as long as the gate existed, and the earlier
  review that removed its false greens did not cover the extension fallback because
  the probe name read as an implementation detail. The new test asserts the
  extension, which is what the fallback got wrong.

## Deferred

Read the baseline with one `git cat-file --batch` instead of one `git show` per
file (about 3 s of the remaining 10 s), and run both sides in a single ESLint
invocation.
