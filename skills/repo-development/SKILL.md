---
name: repo-development
description: Modify, test, and commit this repository safely. Use for any NMG code, test, CI, packaging, or repository-tooling change.
---

# Repository development

Keep the workflow small, evidence-based, and friendly to concurrent Agents.

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
- Keep one authoritative writer for each fact. Observe or reference GitHub,
  Contracts, repository state, verification receipts, and NMG memory through
  their owning interfaces rather than mirroring them into a competing store.

## Before editing

1. Run `npm run agent:context -- <target-path>`. Positional paths route the
   explicit scope without consulting Git. Use `--changed` only when dirty Git
   paths should be added automatically; that mode requires working Git inspection.
   Treat `unknown` reconciliation as missing applicable evidence, and `drifted`
   as a request to inspect the reported declaration, snapshot, or verification
   mismatch. Neither status is an architectural verdict.
2. Inspect `git status --short`; preserve unrelated changes and commit only your files.
3. Read the returned owning design and the exact code you will modify. Experiments are evidence,
   not normative design.
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
2. Update the owning design when behavior or process changes. Follow
   [`doc-maintenance`](../doc-maintenance/SKILL.md).
3. Run the targeted test, then `npm run agent:verify`. With no arguments it
   automatically detects Git changes, selects routes, executes the exact blocking
   checks, and overwrites `.nmg/verification/latest.json` with structured evidence.
   In a shared dirty worktree, pass `-- <owned-path>` so unrelated changes
   stay outside the plan. Use `--include-advisory` only when research or chaos cost
   is intentional.
4. Use `npm run test:research` only for research adapters; use `npm run test:chaos` for explicit lifecycle
   fault testing. Neither substitutes for product tests.
5. For CI, packaging, or generated-output changes, validate from a clean checkout
   or use `--require-clean` in an equivalent clean tree. CI automatically runs the
   named `verify:*` package contracts on push and pull request.
6. Commit one coherent change with only owned files. Leave unrelated user or Agent work untouched.
   Commit messages follow the repository's conventional style
   (`type(scope): summary` + a body that says what changed and why, one change
   per commit). A commit is a proposal, not a proof: the verification evidence
   (targeted test + `agent:verify`) is what makes it hold, so do not claim a
   check passed in the message unless it ran.
7. When opening a pull request, read `.github/pull_request_template.md` and
   follow it as the PR prompt: fill the three description blocks (What / Why /
   Changes) from the change, and self-check every box in the completion
   checklist before marking the PR ready — the checklist is the same contract
   CI enforces, and it catches locally what a CI round-trip would cost. Draft
   PRs and CI status are owned by the forge; the template checklist is the
   submitter's own pre-flight, not a substitute for `All checks passed`.
8. Resolve the in-flight goal after the task is completed or deliberately
   abandoned. The board records that work is active, not a step-by-step history;
   Git and verification evidence remain the source of actual implementation state.

## Repository Control Plane beyond agent:verify

`npm run agent:verify` auto-discovers the contract that uniquely covers the
current scope and runs the equivalent reconcile — that is the default for
ordinary changes (see [`ci-cd-and-quality.md` §7.11](../../docs/design/ci-cd-and-quality.md)).
Use the standalone `nmg-rcp` CLI (`node bin/nmg-rcp.mjs`, contract path first)
only in the scenarios `agent:verify` does not cover:

- **Check CI state without opening the browser:** `nmg-rcp forge-status --pr <n>`
  reads the forge's status-check rollup (`checks[]` with name/conclusion). Use
  it before claiming "checks pass" or deciding a PR is mergeable.
- **Review what a reconcile would do before running it:**
  `nmg-rcp plan <contract>` (and `nmg-rcp compile <contract>` when the contract
  itself changed).
- **Inspect verification evidence:** `nmg-rcp receipt-list` /
  `nmg-rcp receipt-verify <receipt>` / `nmg-rcp receipt-scan` — receipts live
  under `.rcp/receipts/` and are append-only.
- **Retry after a failed reconcile, or run an explicit workspace-ready pass:**
  `nmg-rcp reconcile <contract> --apply --workspace-ready [--recover-attempt]`.
- **Bind a PR or create a draft PR through the forge provider:**
  `nmg-rcp forge-bind <contract> --pr <n>` / `nmg-rcp forge-create <contract> --base main --head <branch>`.

`--apply` never runs by default; reconcile plans unless `--apply` is explicit.
When a Contract's status or verification drift from the design doc, update the
owning document (this SKILL, `ci-cd-and-quality.md`, the RCP decision) in the
same change — an improved tool that stays undocumented is a tool agents will
not reach for.

## Builds and generated artifacts

Regenerable outputs are **not** tracked (see the rejected decision
[Track build artifacts in version control](../../docs/decisions/rejected/2026-09-02-track-build-artifacts-in-git.md)):

- `dist/` (root tsc build), `dsh/dsh-nmg/lib/` (tsdown), and
  `src/prompts/nmg-prompts.generated.ts` (from `nmg-prompts.yaml`) are
  gitignored; the tree stays clean only if you never `git add` them.
- A change to `src/` that feeds a generated output is verified by
  regeneration, not by committing the output.

Reproduce locally, in this order:

1. Root package: `npm ci` (or `npm install` when adding a dependency), then
   `npm run build` — regenerates `src/prompts/nmg-prompts.generated.ts` and
   `dist/`.
2. Subpackages with their own lockfile (currently `dsh/dsh-nmg`, pnpm):
   `cd dsh/dsh-nmg && pnpm install --frozen-lockfile && pnpm run build` —
   regenerates `lib/`. `npm run verify:packages` runs every subpackage from a
   frozen lockfile automatically.
3. `npm run check:lock` fails when the root `package-lock.json` drifted from
   `package.json`; fix with `npm install --package-lock-only`.

When a change touches a subpackage's `src/`, `package.json`, or its lockfile,
`npm run agent:verify` covers it through `verify:static` →
`verify:packages`/`check:lock`.

Never invoke live LLM, embedding, or full benchmark workloads unless the task explicitly calls for them.
