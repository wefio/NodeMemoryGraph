---
name: repo-development
description: Modify, test, and commit this repository safely. Use for any NMG code, test, CI, packaging, or repository-tooling change.
---

# Repository development

Keep the workflow small, evidence-based, and friendly to concurrent Agents.
The code and logic should be easy to maintain.
Complexity must be kept within a limit of 15.

## Repository governance

- Treat the repository as the Agent's working environment. When a recurring task
  is hard to route or verify, improve its existing owner, route, or Skill instead
  of adding a private workaround or another source of truth.
- Treat an Agent completion claim as a proposal. Targeted tests, independent
  verification, clean CI, and—when the change crosses an external boundary—a
  real integration run determine whether the change holds. Each proof is scoped
  to what it actually measured.
- Move work, PRs, decisions, guardrails, and releases only through their explicit
  lifecycle operations. Do not infer a state transition from phrases such as
  "done" or "ship it" and do not bypass its prerequisites.
- Detect entropy aggressively: stale temporary work, expired guardrails,
  duplicate tests, unused compatibility layers, and superseded abstractions.
  Automatically remove only generated, cached, or explicitly expiring material;
  propose reviewable candidates before deleting source, history, public
  interfaces, issues, or pull requests.
- Keep the repository's spending bounded: never invoke live LLM, embedding, or
  full benchmark workloads unless the task explicitly calls for them.
- Keep one authoritative writer for each fact. Observe or reference GitHub,
  Contracts, repository state, verification receipts, and NMG memory through
  their owning interfaces rather than mirroring them into a competing store.
- In a shared or parallel-Agent worktree, isolate before you commit. Run
  `git status --short` first: other Agents' uncommitted changes, or a HEAD that
  moved under you, mean the tree is shared. Never `git add -A` or `git commit -a`
  there; stage only your owned paths. When the worktree is actively shared,
  prefer a dedicated `git worktree add` for your change, commit only your files,
  and hand the shared tree back by reverting only your files to HEAD. A commit
  that silently swallows another Agent's working tree is a coordination failure,
  not a merge. When the change lands or is abandoned, remove the dedicated
  worktree and its branch (`git worktree remove <path>` then `git branch -D
<name>`) so used-up worktrees do not accumulate.

## Before editing

1. Locate the target and its owning contract using the
   [discovery protocol](../../AGENTS.md#find-the-context-for-the-next-action).
   When ownership or checks are unclear, use `npm run agent:context -- <target-path>`.
   Its owner paths are lookup candidates, not a requirement to read whole files.
   Positional paths select explicit scope; `--changed` adds dirty Git paths.
   Reconciliation `unknown` means missing applicable evidence; `drifted` means
   inspect the reported mismatch. Neither status is an architectural verdict.
2. Inspect `git status --short`; preserve unrelated changes and commit only your files.
3. Read the applicable sections of the owning design and the exact code you will
   modify. For documentation or process changes, follow
   [doc-maintenance](../doc-maintenance/SKILL.md); for one-off scripts or ad-hoc
   analysis, follow [script-reuse](../script-reuse/SKILL.md).
4. State a testable outcome. For defects and lifecycle work, write the failing behavior test first.
5. Immediately before the first substantive file write, register one open in-flight
   goal on the `repo-development` Task Board channel. Its content contains only
   `goal`, `approach`, and `scope`; use one entry for the coherent task, not one
   per file or step. Follow the daemon ownership rules in
   [`nmg-memory`](../nmg-memory/SKILL.md), and retain the returned entry ID:

   ```text
   nmg board put repo-development \
     "goal=<outcome>; approach=<intended method>; scope=<owned paths>" \
     --agent <stable-agent-id> --kind goal --ttl-seconds 86400 --json
   ```

   Do not publish progress updates. Writer attribution marks the initial worker;
   another Agent may claim the same open entry if it must take over. If the board
   is unavailable because this task is repairing NMG lifecycle or board code,
   report that limitation and continue rather than making the repository
   unrepairable.

## Classify tests

- **Safety:** prevents corruption, leaks, unsafe deletion, or security regressions. Blocking and durable.
- **Contract:** protects a public API, protocol, package, persistence, or supported integration. Blocking and durable.
- **Guardrail:** temporarily blocks a known regression while the design is being repaired. Put it under
  `tests/guardrails/<id>/` with `guardrail.yaml`; record `reason`, `review_after`, and `exit_criteria`.
- **Characterization/research:** measures current behavior or hypotheses. It must not redefine product
  correctness and is non-blocking in CI.

Do not turn a temporary test into permanent architecture by accident. Promote it to safety/contract,
or remove it when its exit criteria are met.

## Implement and verify

1. Make the smallest coherent change; keep optional infrastructure behind a narrow adapter.
   When adding or changing an environment gate, mode flag, or non-default feature,
   apply the [hidden-feature registration rule](../../docs/decisions/implemented/2026-09-07-register-hidden-features.md#decision)
   in the same change.
2. Update the owning design when behavior or process changes. A non-trivial
   change also adds or updates at least one record under `docs/decisions/` in the
   same commit. It is non-trivial when it alters behavior, a contract shared
   across files or packages, package or module structure, process or tooling,
   test strategy, or an on-disk, wire, or configuration format; formatting,
   comment wording, typo fixes, and behavior-free dependency bumps are exempt.
   Follow [`doc-maintenance`](../doc-maintenance/SKILL.md).
3. Run the targeted test, then `npm run agent:verify`. With no arguments it
   automatically detects Git changes, selects routes, executes the exact blocking
   checks, and overwrites `.nmg/verification/latest.json` with structured evidence.
   In a shared dirty worktree, pass `-- <owned-path>` so unrelated changes
   stay outside the plan. Use `--include-advisory` only when research or chaos cost
   is intentional.
4. Run long checks detached and collect them before the commit. The cheap decisive
   checks — LSP diagnostics on touched files, format, lint, `complexity:gate`,
   `docs:check` — stay synchronous; the expensive three — full `mutation:teeth`,
   `test:product`, the `evals/**` suites — are launched as soon as the code they measure
   is final, while the documentation and the cheap lane are written:

   ```bash
   { echo "started=$(date -Is)"; echo "snapshot=$(git rev-parse HEAD)"; } > .temp/x.state
   (npm run X > .temp/x.log 2>&1; echo "exit=$?" >> .temp/x.state) &
   echo "pid=$!" >> .temp/x.state
   ```

   Each launch is its own statement, header in the foreground: `A && B &` backgrounds the
   whole list, which truncates the state file after its `pid=` line — the one state that
   cannot be read.

   A launch returns immediately and is never followed by a wait — no `sleep`, no poll loop,
   no peeking to see whether the state is worth reading yet: the collector reads it at the
   next natural checkpoint while the time goes to the rest of the change. With nothing else
   to do, run the check synchronously instead.

   **Read a detached run's state as three outcomes, not two.** _Finished:_ the state file
   carries `exit=<code>`, and that code is the result. _Still running:_ no `exit=` yet and
   the recorded pid is alive (`kill -0 <pid>` from a later shell); elapsed time is not a
   state, so a long runtime is never read as a failure, and telling working from wedged uses
   the check's own progress rather than the clock. What that progress *is* depends on the
   check, and the two are not interchangeable: an npm test lane streams its TAP (one line per
   test), while `mutation:teeth` writes its summary only at the end — its live signal is the
   lock file's `target`, which moves as it takes each target, plus the target file's mtime as
   it substitutes and restores. Measuring progress by the wrong one reads a working sweep as
   wedged.
   _Died:_ no `exit=` and the pid is gone, so nothing wrote a code — the run was killed, and
   it may have left a mutant in the tree; the lock says which target, and `git diff` it first.

   A detached run records the tree it measured, and the collector compares that with the
   current one: a code change means re-run. Never edit or stage a file a mutation run is
   rewriting — a running run shows its current target as modified in `git status`, holding a
   live mutant, and anything staged then is the mutant, not the work — and scoped `--targets=`
   runs during a change and one full run before a push answer different questions. The measured
   costs and traps are in
   [the decision](../../docs/decisions/implemented/2026-09-18-detached-long-checks.md).

   **A running sweep makes the tree unreadable, not only unwritable.** Between its substitution
   and its restore the target file **is** the mutant, so `lint`, `complexity:gate` and any other
   check run in that window report on the mutant — and a check that *passes* there is evidence
   about code that never existed. The sweep now says so in the tree (`.temp/mutation-lock.json`,
   `tools/mutation-lock.ts`), `npm run agent:verify` refuses while it is held rather than
   reporting on a mutant, and `npm run agent:context` prints it. Never re-derive that from memory:
   the whole failure class is [post-mortem 0003](../../docs/postmortem/0003-checks-read-a-live-mutant.md).

5. Use `npm run test:research` only for research adapters; use `npm run test:chaos` for explicit lifecycle
   fault testing. Neither substitutes for product tests.
6. For CI, packaging, or generated-output changes (see
   [builds and generated artifacts](references/builds.md)), validate from a clean checkout
   or use `--require-clean` in an equivalent clean tree. CI automatically runs the
   named `verify:*` package contracts on push and pull request.
7. Commit one coherent change with only owned files. Leave unrelated user or Agent work untouched.
   Commit messages follow the repository's conventional style
   (`type(scope): summary` + a body that says what changed and why, one change
   per commit). A commit is a proposal, not a proof: the verification evidence
   (targeted test + `agent:verify`) is what makes it hold, so do not claim a
   check passed in the message unless it ran. Evidence has no third state: a
   failure that cannot be reproduced is recorded with its reproduction attempt and rate,
   or left open — never as "flaky", which is a label that closes a question nobody
   answered ([post-mortem 0004](../../docs/postmortem/0004-flaky-was-a-clock-boundary.md)).
8. When opening a pull request, read `.github/pull_request_template.md` and
   follow it as the PR prompt: fill the three description blocks (What / Why /
   Changes) from the change plus `未验证项`, which names the surface the change did
   not exercise — a route that did not run, a platform or environment that was not
   built or booted, a build mode, or a behavior with no reproducer. Write `None.`
   only when nothing is outstanding. That declaration states scope; it never
   replaces a check and a green gate never makes it unnecessary. Then self-check
   every box in the completion checklist before marking the PR ready — the
   checklist is the same contract
   CI enforces, and it catches locally what a CI round-trip would cost. Draft
   PRs and CI status are owned by the forge; the template checklist is the
   submitter's own pre-flight, not a substitute for `All checks passed`.
9. Resolve the in-flight goal after the task is completed or deliberately
   abandoned. The board records that work is active, not a step-by-step history;
   Git and verification evidence remain the source of actual implementation state.

## When to read the manual

Everything above is the path an ordinary change walks. Two subjects are only needed
for a specific kind of change:

- For RCP operations `agent:verify` does not cover (forge status, plan/compile,
  receipts, an explicit reconcile, PR binding), and for the rule against scanning
  oversized trees by default: [control plane](references/control-plane.md)
- For building this repository, regenerating outputs, subpackage installs, or
  lockfile drift: [builds and generated artifacts](references/builds.md)
