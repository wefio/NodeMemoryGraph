# Register every entry point with one sentence

[中文](2026-09-09-register-every-entry-point.zh-CN.md)

**Status:** proposed  
**Relates to:** 2026-09-09-gates-assert-results-not-tools

## Problem

`package.json` declares 93 scripts and nothing says what any of them is for. Four
partial registries exist — the root `README.md` names 12, `evals/README.md` 30,
`docs/design/ci-cd-and-quality.md` 22, `AGENTS.md` 6 — together covering 59, plus
per-directory READMEs that cover 16 of 28 eval directories. Nine scripts appear
nowhere at all: `index:qwen3`, `hotspot:modules`, `perf:hotspots`,
`eval:recall-compression`, `eval:perf-overhead`, `eval:concurrency`,
`benchmark:ablate:reverse-retrieval`, `benchmark:merge:longmem`, `lint:fix`.

The invocable surface is wider than `package.json`. `bin/` holds two entry points
and the RCP CLI holds ten subcommands. A census of the 178 candidate files under
`tools/`, `scripts/`, `evals/`, `bin/` found **23 whose name appears in no other
file in the repository** — mostly `evals/omnimemeval/research/**` probes and
audits, plus `tools/fork-merge-demo.ts` and `evals/retrieval/profile-*.ts`. RCP
itself is clean: all ten of its subcommands are documented (1 to 47 mentions).

The cost is not tidiness. On 2026-09-09 an Agent asked "which scripts have no
consumer?", wrote a throwaway script to answer it, and had to write two more
because the first two were wrong — the second missed the scripts composed inside
`verify:static`, the third missed the root `README.md`. It never once ran
`npm run agent:context`, which `AGENTS.md` requires as the first step of any
repository change. And when the same question was asked of
`scripts/hotspot-files.ts`, the answer was discoverable only by opening the file:
*"This is the analysis that motivated the split… re-run it after changes to see
if hotspots have moved."* A purpose that lives in a header comment has no reader.

## Proposal

One file, `docs/scripts.yaml`, is the single home for "how do I invoke this and
when do I reach for it". One entry per invocable entry point — a package script,
a `bin` command, or a standalone file:

```yaml
- entry: hotspot:modules
  when: 想知道 store 模块的调用热点有没有迁移
- entry: nmg-rcp reconcile
  when: 改完仓库要一条能复算的验证收据
- entry: tools/fork-merge-demo.ts
  when: 想看图合并分支的实际行为
```

`when` is a trigger prompt, not a description: it answers *when* an Agent or a
human should reach for it, in the same spirit as a Skill's description.

`docs:check` gains two checks:

- **Error** — every `package.json` script has exactly one entry, and every entry
  naming a script resolves to one. This set is exactly enumerable from
  `package.json`, so the check cannot be wrong.
- **Warning** — a file under `tools/`, `scripts/`, `evals/`, or `bin/` whose name
  appears in no other tracked file, and a CLI subcommand string in
  `src/cli/main.ts` or `src/rcp/cli/main.ts` that appears in no document. Both
  mean "nothing anywhere explains this". The check is approximate by
  construction — it cannot see a Python module imported as a package, and it
  treats any mention as an explanation — so it warns rather than fails until the
  set is empty.

Writing the sentence is the test of whether the entry point deserves to exist. A
script whose `when` cannot be written — or whose `when` would duplicate another's
— is deleted instead of registered. `index:qwen3` is the first: its command is
byte-identical to `index:embeddings`, so its sentence would be too.

## Alternatives considered

**Extend the four existing registries.** They are prose documents about CI policy
and evaluation strategy; a complete inventory would have to be restated in each.
Rejected: four homes for one fact.

**Put the sentence in each file's header comment.** That is already where
`hotspot-files.ts` hid its purpose. Rejected: not discoverable without opening
every file.

**A `scriptsMeta` block inside `package.json`.** npm has no standard per-script
description. Rejected: a non-standard shape inside a tool-owned file.

**Rely on the per-directory README convention.** It is already partial (16 of 28
eval directories) and the nine unregistered scripts are exactly what it misses.

**A gate instead of a registry.** A check that only says "this file is referenced
somewhere" tells nobody what it is for. Rejected: it would have passed on all
nine, because each one's only reference was itself.

**Gate only `package.json`.** Rejected: `bin/` and the CLI dispatchers are equally
invisible, and the census found 23 unexplained files outside `package.json`.

**Resolve entry points by import analysis.** Would make the second check exact,
but needs per-language parsing (`import`, `require`, Python `from x import`) and
still cannot decide whether a leaf file is an entry point or a library. Rejected:
the name-mention check catches most of it in ten lines.

## Acceptance criteria

- `docs/scripts.yaml` exists with exactly one entry per `package.json` script.
- `docs:check` fails on a script with no entry, on an entry naming no script, and
  on a script with two entries; `tests/docs/verify-docs.test.ts` covers all three.
- The warning-level check reports today's 23 unexplained files and the
  undocumented CLI subcommands, and stays a warning until that set is empty.
- Every one of the nine currently unregistered scripts is registered or deleted.
- The root `README.md` and `skills/nmg-memory/SKILL.md` point at the registry.

## Risks

- The registry can rot into a restatement of `package.json`. Mitigation: it
  carries only the `when` sentence, which `package.json` cannot express, and the
  error-level check enforces set equality rather than content.
- A 105-entry file is a large diff to review once. Accepted: it is written once
  and changes one line at a time afterwards.
- `when` sentences are not mechanically checkable, so a vague one passes.
  Accepted: completeness is the part that rots.
- The warning-level check has false positives — a package `__init__.py`, a module
  imported only by another language. Accepted: it warns, and the set is small
  enough to read by hand.
- Registration can become a ritual that keeps a dead script alive by giving it a
  sentence. Mitigation: the sentence must name a question someone still asks;
  that is a review judgement, not a check.
- **This decision answers "what is this for", not "will it be used".** Evidence
  from 2026-09-09 says Agents write one-off scripts because the preference is
  model-level and the reward structure rewards it, so no registry can change that.
  Enforcement lives in `2026-09-09-gates-assert-results-not-tools`, which this
  decision is subordinate to.

## Deferred

- Promote the warning-level check to an error once the 23-file set is empty.
- Cover the `nmg` CLI's subcommand strings, which are dispatched by `command ===`
  comparisons rather than `case`, once the enumeration is reliable.
