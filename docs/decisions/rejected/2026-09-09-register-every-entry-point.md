# Register every entry point with one sentence

[中文](2026-09-09-register-every-entry-point.zh-CN.md)

**Status:** rejected  
**Relates to:** 2026-09-09-gates-assert-results-not-tools

## Problem

`package.json` declares 93 scripts and nothing says what most of them are for. Four
partial registries exist — the root `README.md` names 12, `evals/README.md` 30,
`docs/design/ci-cd-and-quality.md` 22, `AGENTS.md` 6 — together covering 59, plus
per-directory READMEs covering 16 of 28 eval directories. Nine scripts appear nowhere at
all: `index:qwen3`, `hotspot:modules`, `perf:hotspots`, `eval:recall-compression`,
`eval:perf-overhead`, `eval:concurrency`, `benchmark:ablate:reverse-retrieval`,
`benchmark:merge:longmem`, `lint:fix`.

The invocable surface is wider than `package.json`. `bin/` holds two entry points and the
RCP CLI holds ten subcommands. A census of the 178 candidate files under `tools/`,
`scripts/`, `evals/`, `bin/` found **23 whose name appears in no other file in the
repository** — mostly `evals/omnimemeval/research/**` probes and audits, plus
`tools/fork-merge-demo.ts` and `evals/retrieval/profile-*.ts`. RCP itself is clean: all
ten of its subcommands are documented (1 to 47 mentions).

The cost is not tidiness. On 2026-09-09 an Agent asked "which scripts have no consumer?",
wrote a throwaway script to answer it, and had to write two more because the first two
were wrong — the second missed the scripts composed inside `verify:static`, the third
missed the root `README.md`. It never once ran `npm run agent:context`, which `AGENTS.md`
requires as the first step of any repository change.

## Proposal

One file, `docs/scripts.yaml`, as the single home for "how do I invoke this and when do I
reach for it". One entry per invocable entry point — a package script, a `bin` command, or
a standalone file:

```yaml
- entry: hotspot:modules
  when: 想知道 store 模块的调用热点有没有迁移
- entry: nmg-rcp reconcile
  when: 改完仓库要一条能复算的验证收据
```

`when` is a trigger prompt, not a description. `docs:check` gains two checks: **error**
for set equality against `package.json` scripts (exactly enumerable, so it cannot be
wrong), and **warning** for a file or CLI subcommand string whose name appears in no other
tracked file. A script whose `when` cannot be written — or whose `when` would duplicate
another's — is deleted instead of registered. `index:qwen3` was named as the first
candidate, since its command is byte-identical to `index:embeddings`.

## Alternatives considered

**Extend the four existing registries.** They are prose documents about CI policy and
evaluation strategy; a complete inventory would have to be restated in each. Rejected:
four homes for one fact.

**Put the sentence in each file's header comment.** Rejected at the time because
`hotspot-files.ts` had already hidden its purpose that way, and "a purpose that lives in a
header comment has no reader". The premise was wrong — see below.

**A `scriptsMeta` block inside `package.json`.** npm has no standard per-script
description. Rejected: a non-standard shape inside a tool-owned file.

**Rely on the per-directory README convention.** Already partial (16 of 28 eval
directories) and the nine unregistered scripts are exactly what it misses.

**A gate instead of a registry.** A check that only says "this file is referenced
somewhere" tells nobody what it is for. Rejected: it would have passed on all nine,
because each one's only reference was itself.

**Gate only `package.json`.** Rejected: `bin/` and the CLI dispatchers are equally
invisible, and the census found 23 unexplained files outside `package.json`.

**Resolve entry points by import analysis.** Would make the second check exact, but needs
per-language parsing and still cannot decide whether a leaf file is an entry point or a
library.

## Why rejected

- **The registry already exists, one level up.** `agent-context.yaml` carries
  `capabilities:` (id, aliases, summary, entrypoints, supports) and `routes:` (paths,
  owners, tests, verify); `agent:context:check` enforces it and `npm run agent:context`
  reads it, and `AGENTS.md` already makes that the first step of a repository change. A
  `docs/scripts.yaml` would be a **second** catalogue answering the same question at a
  different granularity — five capabilities against ninety-three scripts. That is one
  home too many for one fact.
- **The checkable form and the useful form are different sizes.** To fail on a missing
  entry, the file must enumerate _every_ script. To be useful, it should list only what
  nothing else explains. Ninety-three lines of prose bought with nine lines of value.
- **The premise used to reject the cheapest option was false.** "A purpose in a header
  comment has no reader" assumed the headers were already there. Measured on
  2026-09-09: **24 of the 33 entry-point files under `tools/`, `scripts/` and `bin/` carry
  no header comment at all.** So the alternative was not free — but its cost is 24 lines
  written once, at the point of use, where the reader is whoever opens the file.
- **The nine were mostly explained already; the npm alias was not.** `benchmark:ablate:reverse-retrieval`
  is described in `evals/omnimemeval/README.md`, which prints the underlying
  `python …reverse-retrieval-ablation.py` command. The audit measured the absence of a
  _reference to the alias_, not the absence of an explanation — and reported it as the
  latter.
- **A warning that measures references, not use, never empties.** The 23-file set contains
  `evals/omnimemeval/research/**`, which will stay unreferenced indefinitely. A warning
  nobody can clear becomes an ignore list, and then the check is gone.

## What was done instead

- `index:qwen3` deleted from `package.json` — the one provably dead alias, byte-identical
  to `index:embeddings`. `scripts/index-qwen3.ts` stays, since `index:embeddings` runs it.
- The remaining eight explained where their readers already are, one line each:
  `evals/README.md` gains a "One-off measurement scripts" table (five entries) and
  `docs/design/ci-cd-and-quality.md` gains the three local-only commands.
- No new file, no new check, and no standing rule. The audit above is kept here as the
  reason a future proposal to build a central registry does not have to repeat it.
