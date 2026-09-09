---
name: script-reuse
description: Use when a task needs a throwaway script, ad-hoc analysis, or probe in this repository — how to write one that is right (flags, no silent zeros, a self-check, provenance in the output), and where the ready-made parts are if you would rather import them.
---

# Write the one-off script, and write it right

A one-off script is the normal answer to a one-off question. **Write it.** Nothing
here is meant to talk you out of that. Two things are governed instead:

- do not write the **second** copy of a part that already exists;
- do not ship a script that **quietly produces a wrong number** — the number gets
  quoted long after the script is deleted.

[The parts shelf](../../docs/guides/parts.md) is the other half of the offer: if a
ready-made piece fits — percentiles, `mapConcurrent`, atomic JSON writes, the
control-plane API — import it instead of re-deriving it. That is a shortcut, not a
requirement. A script with its own three-line helper is fine as long as it is the
_first_ copy.

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

This is the difference between a **routine** and a **one-off entry point**. The
entry point may be thrown away; the routine stays as soon as a second script needs
it. Until then, co-locate it with its only consumer.

## Rules about parts

- **A part is an import, not a command.** Do not add an `nmg-rcp` subcommand, an
  npm script, or a new `tools/*.ts` entry point because one task needed a
  composition. Nobody else will call it, and it will rot.
- **The second definition is the signal.** If a helper you just wrote already
  exists in another file, move it to a place both can import. Where is your call;
  it only has to sit outside the module that already owns the concept.
- **Never move judgement into a part.** Choosing narrow versus full, or deciding
  whether a change is acceptable, stays in one reviewed place. A part that makes
  that choice for you is a gate wearing a library's clothes.
- **Throwaway means throwaway.** Do not commit the script. Commit only the part,
  and only once a second script needs it.

## When a part is missing

Write the script first. Then ask whether a second script needs the same piece. If
it does, that is when the piece goes on the shelf — and the shelf entry states what
it does, its signature, and a minimal call.

`docs/guides/parts.md` also lists the families still duplicated locally, with the
count. Start there.

## What is not mechanized

No gate can decide "this script is correct" or "this script has a self-check" from
the file alone. A gate can only fail a **second definition** of a part, which is why
the duplication check is the one that got proposed and the rest is prose. Prose is
weak by nature — the template above exists so that following it is faster than
ignoring it.
