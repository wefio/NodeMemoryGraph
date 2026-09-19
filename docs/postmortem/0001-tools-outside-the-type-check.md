# 0001 - The tool that checks the others is not itself checked

[中文](0001-tools-outside-the-type-check.zh-CN.md)

**Status:** open

## Executive summary

Two mutant anchors whose newlines I had written through a shell text path reached `tools/mutation-teeth.ts`
as real newlines inside a TypeScript string literal, so the tool died with `ERR_INVALID_TYPESCRIPT_SYNTAX`
instead of running - twice in one session, through the same mechanism. Nothing type-checks `tools/**`:
`npm run check` exits **0** with `const x: number = "not a number";` planted in a `tools/` file, because
`tsconfig.json` names exactly three `tools/` files and ESLint does not cover the directory. The type error
class this hides is measurable: adding `tools/**/*.ts` to the include list produces **3 errors in 2 files**.
The lesson: an allow-list of checked files makes "unchecked" the default for every new tool, and the missing
check is exactly what a mechanical edit path will find.

## Summary

While adding a mutation tooth I generate an anchor and a replacement as TypeScript string literals. Writing
them through a shell or Python path converts intended `\n` escapes into real line breaks, which is not a
type error but a syntax error in the module - so the file is broken at rest and only fails when Node loads
it. Both times the repair was a rewrite through an editor that treats the text literally.

The systemic half is not the escaping mistake; it is that the repository had no way to notice. `tsconfig.json`
includes `src/**`, `.pi/extensions/**`, `claude-plugins/**`, and three named files under `tools/`
(`autodiff-benchmark.ts`, `repo-context.ts`, `agent-verify.ts`). `tools/mutation-teeth.ts` is not among
them, and ESLint's configured globs exclude the directory. A tool whose output other reviewers treat as
evidence - "27 of 27 mutants caught" - is therefore the least checked code in the change.

## Impact

No false evidence was produced: the tool refuses to start, so it never reported a mutant as caught, and no
number from it was published while it was broken. The cost was two debugging rounds spent on a failure the
type checker would have reported immediately.

What was hidden is different and larger: type-level rot in any unchecked `tools/` script is invisible. On the
tree this was measured against, extending the include list surfaces `tools/fork-merge-demo.ts(89,39)` and
`(90,39)` (`TS18046`, `json.left`/`json.right` are `unknown`) and one `TS2322` in `tools/complexity-gate.ts`.
Those errors are pre-existing, not introduced here, and they are what the guardrail would have to clear first.

## Timeline

- B3b, adding the tooth `round-publication-opens-its-own-transaction`: the anchor was written through a shell
  path, the escapes became newlines, and `npm run mutation:teeth` failed with `ERR_INVALID_TYPESCRIPT_SYNTAX`.
  Repaired by re-writing the same literal through an editor that preserves `\n`.
- The single-boundary slice, adding the tooth `a-method-opens-its-own-transaction`: the same write path
  produced the same defect in the same file. Both the write and the repair repeated.
- Probing the root cause: `const x: number = "not a number";` in a new `tools/` file, then `npm run check` -
  **exit 0**.
- Measuring the guardrail's cost: a copy of `tsconfig.json` with `tools/**/*.ts` added - **3 errors, 2 files**.

## Root cause

The set of type-checked files is an allow-list, so a new tool joins the unchecked set by default and nothing
announces it. An unchecked file cannot fail a check, and a syntax error in a file that is never loaded by a
test is not observed at all - it is observed by the first person who runs it, in the middle of a run whose
partial output looks like progress. Any mechanical transformation that writes TypeScript source without
respecting its escaping (shell heredocs, Python string writes, `sed`) lands in that blind spot.

This is why "I will be careful" is not the fix: the edit that broke it and the edit that repaired it were the
same keystrokes in a different tool, and only one of them was checkable.

## Guardrails added

Not yet. The candidate is a one-line change to `tsconfig.json`:

```json
"tools/**/*.ts"
```

with the 3 measured errors cleared first. It is not landed here because the CI contract's owner is editing
the same files in the same worktree; landing it from this session would have made two in-flight changes
overlap. Until it lands, this class is still uncaught and the record stays `open`.

The instance-level habit that survived is narrower and worth stating: mutant anchors are written with an
editor that preserves `\n`, never generated through a shell string.

## Lessons

- An allow-list of checked files is a promise about existing files; it says nothing about the next one.
  Prefer a glob that includes the directory, and let the exceptions be explicit.
- "It is only a tool" is the wrong direction for scrutiny. The more a tool's output is quoted as evidence,
  the more it needs the same checks as the code it judges - the mutation tool is the extreme case, because
  its output is a count that nobody re-derives by hand.
- A failure that happens _before_ the tool starts is a lucky failure. The same blind spot would have hidden
  a wrong result just as well.
