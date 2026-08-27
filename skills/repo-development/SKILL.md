---
name: repo-development
description: Modify, test, and commit this repository safely. Use for any NMG code, test, CI, packaging, or repository-tooling change.
---

# Repository development

Keep the workflow small, evidence-based, and friendly to concurrent Agents.

## Before editing

1. Run `npm run agent:context -- --scope <target-path>`.
   Treat `unknown` reconciliation as missing applicable evidence, and `drifted`
   as a request to inspect the reported declaration, snapshot, or verification
   mismatch. Neither status is an architectural verdict.
2. Inspect `git status --short`; preserve unrelated changes and commit only your files.
3. Read the returned owning design and the exact code you will modify. Experiments are evidence,
   not normative design.
4. State a testable outcome. For defects and lifecycle work, write the failing behavior test first.

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
   In a shared dirty worktree, pass `-- --scope <owned-path>` so unrelated changes
   stay outside the plan. Use `--include-advisory` only when research or chaos cost
   is intentional.
4. Use `npm run test:research` only for research adapters; use `npm run test:chaos` for explicit lifecycle
   fault testing. Neither substitutes for product tests.
5. For CI, packaging, or generated-output changes, validate from a clean checkout
   or use `--require-clean` in an equivalent clean tree. CI automatically runs the
   named `verify:*` package contracts on push and pull request.
6. Commit one coherent change with only owned files. Leave unrelated user or Agent work untouched.

Never invoke live LLM, embedding, or full benchmark workloads unless the task explicitly calls for them.
