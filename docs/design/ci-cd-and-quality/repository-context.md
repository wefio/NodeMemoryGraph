# Locate repository ownership and interpret verification state

[中文](repository-context.zh-CN.md) · [Terms used](repository-context.terms.yaml)

**Authority:** [Code quality and CI/CD](../ci-cd-and-quality.md).

## Agent-native repository context

Use this reference to find who owns a change, select checks and determine whether
existing evidence applies to current declarations and content. `agent:context`
provides navigation and a read-only reconciliation view. It neither runs
verification nor judges architectural correctness.

### Find the owner of a change

Root `AGENTS.md` owns the stable discovery protocol. Locate implementation and
contracts from task terms, symbols and directories, then read the sections needed
for the current action. The root entry does not maintain module inventories,
commands or execution state. A known target can be searched directly; the context
tool is not a mandatory first step. When ownership or checks are unclear, run:

```powershell
npm run agent:context -- --scope <target-path>
```

Replace `<target-path>` with the repository path this task will change. Returned
owner paths are lookup entry points, not whole-file reading requirements.
`skills/doc-maintenance/SKILL.md` owns on-demand documentation maintenance;
`skills/repo-development/SKILL.md` owns modification, testing and commits.
Use the [verification pipeline](../ci-cd-and-quality.md#agent-verification-pipeline)
for development checks: invoking navigation is not correctness evidence.

In a shared dirty worktree, prefer exact `--scope` paths. Use `--changed` only
when all current changes belong in scope; it includes the whole worktree's dirty
paths and may include another Agent's work.

### Find an existing capability

For stable entry points that can perform a kind of work, run
`npm run agent:context` without arguments to inspect the capability directory.
If a name or alias is known, positional `capability:<id-or-alias>` maps it to the
existing route, owner and verification requirements.

`agent-context.yaml` owns module ownership, verification classifications and a
small capability directory that cannot be reliably inferred. Each capability
contains only stable IDs/aliases, a short responsibility, code paths, commands
and supported objects—not design, completion state, experiment results or live
service state. `package.json` owns npm commands; source code,
`completion-audit.md` and `temporary-todo.md` own implementation facts, completion
audits and unresolved work respectively. Configuration checks detect declaration,
route and npm-entry drift; they do not create another source of truth.

Each route explicitly separates `blocking` and `advisory` commands, matching
`package.json` scripts exactly. Do not substitute the broad `test` entry for
`test:product`, `test:research` or `test:chaos`.

### Know where the view comes from

`tools/repo-context.ts` derives the task view from Git, `package.json`,
`agent-context.yaml`, owner documents and temporary guardrail manifests. It is
read-only: no NMG database access, daemon startup, LLM or embedding calls.

The capability directory is static navigation, not a dynamic service catalog,
health check or second repository-state system.

### Interpret declaration reconciliation

The read-only reconciliation view separates repository sources from execution
receipts:

| Input | Identity bound | Evidence limit |
| --- | --- | --- |
| desired revision | Stable fingerprint of selected routes, verification classifications and package scripts | Changed declarations invalidate applicability of old evidence. |
| observed revision | Selected scope and its current content | Further edits to the same dirty file change the fingerprint; HEAD and filenames alone cannot justify reuse. |
| verification evidence | `.nmg/verification/latest.json` | It must match both revisions and cover every blocking check. |

Git HEAD is recorded separately for provenance. A commit-metadata-only operation
must not invalidate evidence for unchanged content.

| State | Meaning | Next action |
| --- | --- | --- |
| `unknown` | No applicable evidence, or old evidence lacks state fingerprints. | Obtain evidence for current declarations/content; absence is not a pass. |
| `converged` | All blocking checks passed for the same declarations and observation snapshot. | Interpret the result only within that scope and check surface. |
| `drifted` | Unresolvable routes, declarations/content changed after verification, corrupt evidence, or a blocking check failed or did not run. | Inspect the reported mismatch or failure, address it and obtain applicable evidence. |

`agent:context`, `agent:verify` and CI events drive reconciliation; it is not a
background daemon. `drifted` means declarations, observations and evidence have
not converged—not that architecture is wrong. Owners, decisions and Agent review
still judge dependency direction, public protocols, persistence boundaries and
default capabilities. Static tests can protect established architecture fitness
functions; the control plane does not carry product or architectural intelligence.
