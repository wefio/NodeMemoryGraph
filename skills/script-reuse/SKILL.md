---
name: script-reuse
description: Create or change scripts, analysis tools, probes, and maintenance automation in this repository, including one-off work, retained reproducers, and resumable jobs.
---

# Write the one-off script, and write it right

[中文](SKILL.zh-CN.md) · [Terms used](SKILL.terms.yaml)

A one-off script is the normal answer to a one-off question. **Write it.** Nothing
here is meant to talk you out of that. Two things are governed instead:

- do not write the **second** copy of a part that already exists;
- do not ship a script that **quietly produces a wrong number** — the number gets
  quoted long after the script is deleted.

These boundaries also apply when a script is retained for others to rerun.
Before adding a helper or orchestration block, search the relevant code and
[parts shelf](../../docs/guides/parts.md) for its responsibility, not just its
proposed name. Import an existing implementation when its contract fits. The
shelf is a discovery aid, not a required dependency or an exhaustive inventory.
A local helper is fine for its first consumer; actual reuse, not anticipated
reuse, justifies extraction.

## What makes it right

In the order these bite:

1. **One command line, no editing.** Inputs come from flags, not from constants you
   edit before each run. `node:util` already has `parseArgs`; do not write one.
2. **Refuse to run on missing input.** Missing flag, missing file, empty dataset →
   throw. A run over zero rows must not print a number.
3. **Assert something about the result.** Counts add up, values are finite, parts
   sum to the whole. One `if (...) throw` is enough; it is the only thing that
   separates "measured" from "ran".
4. **Say what you measured in the output.** The script is throwaway, its output is
   not. Write the input path, row count, and timestamp next to the number, so the
   number can still be interpreted after the script is deleted.
5. **Fail loudly and non-zero.** Never `catch {}`, never `process.exit(0)` after a
   failure, never `?? 0` to paper over a missing value on a measurement path.

```ts
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { writeJsonAtomic } from "../tools/parts/fs.ts";
import { mean } from "../tools/parts/stats.ts";

const { values } = parseArgs({
  options: { input: { type: "string" }, out: { type: "string" } },
});
if (!values.input || !values.out) throw new Error("usage: --input <file> --out <file>");

const rows = JSON.parse(readFileSync(values.input, "utf8")) as number[];
if (rows.length === 0) throw new Error(`${values.input} has no rows`);
if (!rows.every(Number.isFinite)) throw new Error(`${values.input} has a non-finite value`);

writeJsonAtomic(values.out, {
  input: values.input,
  rows: rows.length,
  measuredAt: new Date().toISOString(),
  mean: mean(rows),
});
```

## The shape of a routine (already in this repo)

`scripts/pi-paths.ts`, `scripts/pi-turns.ts`, and `scripts/pi-timeout.ts` are the
existing example: one routine per file, exporting only functions, imported by
`scripts/pi-control.ts`, each with its own `tests/scripts/*.test.ts`.

- One routine per file, named after what it does. The entry point imports it
  instead of inlining it.
- The doc comment says **why it exists** — `pi-timeout.ts` explains that Pi's event
  timeout does not cover a prompt request that never acknowledges — not what the
  signature already says.
- Bad input throws at the boundary: `parsePiPromptTurns` rejects an empty message
  and a misplaced `--turn`.
- It has a test.
- Importing a routine does not start a job, parse the caller's arguments, or
  mutate artifacts. Execution effects belong to an explicit entry point.

This is the difference between a **routine** and a **one-off entry point**. The
entry point may be thrown away; the routine stays as soon as a second script needs
it. Until then, co-locate it with its only consumer.

## Rules about parts

- **A part is an import, not a command.** Do not add an `nmg-rcp` subcommand, an
  npm script, or a new `tools/*.ts` entry point because one task needed a
  composition. Nobody else will call it, and it will rot.
- **The second definition is the signal.** Reuse the existing owner or extract
  the shared responsibility when a second consumer needs it. This includes
  process startup, readiness, retries and cleanup, not only small calculations.
  Keep experiment-specific choices at the caller; do not build a framework for
  hypothetical consumers.
- **Shared meaning has one implementation owner.** Parsing, eligibility,
  normalization and metrics used for comparison come from their owning
  contract, not a copied local variant. A deliberate alternative has a distinct
  name and contract. An independent verification implementation remains a
  labelled check, compared on shared cases, not a competing operational default.
- **Never move judgement into a part.** Choosing narrow versus full, or deciding
  whether a change is acceptable, stays in one reviewed place. A part that makes
  that choice for you is a gate wearing a library's clothes.
- **Distinguish disposable work from maintained entry points.** Do not commit
  a disposable script. If other work depends on rerunning its command, retain it
  at the relevant owner with documented inputs and checks instead of calling it
  temporary. A shared part still needs an actual second consumer.

## When a part is missing

Write the script first. Then ask whether a second script needs the same piece. If
it does, that is when the piece goes on the shelf — and the shelf entry states what
it does, its signature, and a minimal call.

Use the [parts shelf](../../docs/guides/parts.md) to find callable imports that
exist now; it is not a backlog of helpers to build. If no entry fits, apply the
policy above.

## Own execution and resume boundaries

- **Declare resource ownership.** A command that starts a process or opens a
  writable workspace distinguishes resources it creates from resources it
  borrows. Isolate writable state and endpoints, or acquire the existing
  exclusive-use mechanism before sharing them. Clean up owned resources on
  success and failure; do not stop or delete borrowed resources.
- **Bind reused output to the work that produced it.** Before resuming or
  reusing a result, compare its recorded identity with the requested work:
  input content or immutable revision, result-affecting configuration,
  implementation/schema version, and model or prompt version where relevant.
  A path, row ID or existing answer is not that identity. Missing or changed
  identity starts a separate run, unless the owner provides an explicit,
  checked compatibility or migration rule. Record non-secret identity fields,
  not credentials or whole environment files.
- **Persist completed work safely.** Record completion only after the unit's
  required outputs are durable. Reuse only compatible completed units; identify
  reused and newly computed work separately in the report. Use the existing
  atomic-write or checkpoint facility rather than copying it.

Before describing an entry point as runnable, apply
[entry-point verification](../verification-traceability/SKILL.md#verify-the-executed-boundary).
For conclusions drawn from its output, apply the existing
[reader review](../doc-maintenance/references/reader-review.md#review-and-acceptance).

## What is not mechanized

No gate can decide whether a script is correct or contains an effective self-check
from the file alone. The parts-shelf check only verifies that named functions are
still exported from `src/rcp` or `tools/parts`; it does not check signatures,
examples, or duplicated helper bodies. The script author remains responsible for
those properties. Prose is weak by nature — the template above exists so that
following it is faster than ignoring it.
