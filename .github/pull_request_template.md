## Change summary

<!-- Explain in one or two paragraphs what this PR changes and why. Follow the
     proof-before-trust rule in ci-cd-and-quality.md: PR prose is not evidence
     that a change works; the checklist and CI are. -->

**What** (what changed):

**Why** (why it changed / what problem it addresses):

**Changes** (key changes, by file or module):

---

## Not verified

<!-- State the scope this PR did not verify: routes not run, platforms or
     environments not built or started, build modes not covered, and behaviors
     without reproduction steps. Write None. only when nothing remains
     unverified. This is a scope declaration, not evidence: it cannot replace
     any check, and an all-green gate does not make it unnecessary. -->

**Not verified** (what was not verified):

---

## Completion checklist

<!-- Review each item before merging. GitHub owns PR/CI status; this checklist
     is only a submitter-side preflight. -->

### Local quality checks

- [ ] `npm run verify:static` passes (build / package:check / check / check:lock / lint / format:check / docs:check / agent:context:check / complexity:gate / verify:packages)
- [ ] `npm run test:product` passes (or run `npm run agent:verify -- <path>` for the changed route)
- [ ] If dependencies or a lockfile changed: `npm run check:lock` passes, the root `package-lock.json` is synchronized, and `npm audit --omit=dev --audit-level=high` reports no vulnerabilities
- [ ] If a subpackage changed (such as `dsh/dsh-nmg`): `npm run verify:packages` passes (frozen-lockfile install + build), and `pnpm-lock.yaml`/the lockfile matches `package.json`
- [ ] For documentation changes, `npm run docs:check` was run; decision/design changes follow the doc-maintenance rules
- [ ] **Every doc owner this change touches is named here**, with the file that was added or edited: decision record (`docs/decisions/`), design (`docs/design/`), experiment (`docs/experiments/`), postmortem (`docs/postmortem/`), guide (`docs/guides/`) — or `none`, with the reason. A behaviour change with no owner named is a defect, not an omission: the next reader has nowhere to look. "Updated docs" without a path does not satisfy this item.
- [ ] `## Not verified` is filled in (write `None.` if nothing remains); non-trivial changes include a decision record
- [ ] New code methods stay within the cyclomatic-complexity threshold (CodeFactor / `npm run complexity:gate`)
- [ ] No reproducible build artifacts are committed: do not check in `dist/`, `dsh/dsh-nmg/lib/`, `src/prompts/nmg-prompts.generated.ts`, or `.nmg-search-scope` (see `docs/decisions/rejected/2026-09-02-track-build-artifacts-in-git.md`)

### RCP (Repository Control Plane)

<!-- Each item gives an executable command: this is an operational checklist;
     running the command completes the submitter's self-check for that item.
     See the "Repository Control Plane beyond agent:verify" section in
     skills/repo-development/SKILL.md for command details. -->

- [ ] Before the first substantive write, register an in-flight goal on the `repo-development` board:
      `nmg board put repo-development "goal=…; approach=…; scope=…" --agent <id> --kind goal` (then resolve it)
- [ ] Reconcile the changed route successfully and record evidence:
      `npm run agent:verify -- <path>` (or `nmg-rcp reconcile <contract> --apply --workspace-ready`)
      → `.nmg/verification/latest.json` covers the changed route
- [ ] Confirm all-green CI through RCP observation, not manual polling:
      checks from `nmg-rcp forge-status --pr <PR number>` are all SUCCESS
- [ ] Commit only files owned by this PR; do not absorb another Agent's staged or working-tree changes
      (check with `git status --short`)

### CI completion confirmation

<!-- Use RCP/forge observation to confirm completion; do not poll individual
     jobs. `nmg-rcp forge-status --pr <PR number>` in the RCP section is the
     authoritative view; the items below are supplementary. CI usually takes
     about 90 seconds from push to completion. Wait briefly, then recheck with
     `nmg-rcp forge-status --pr <PR number>`; do not repeatedly poll by a fixed
     timer or treat "looks like it is running" as "passed." -->

- [ ] `All checks passed` from `nmg-rcp forge-status --pr <PR number>` is SUCCESS
      (or CI Status Snapshot `.nmg-ci/status.json` has `conclusion: "success"` and `failures: []`)
- [ ] CodeFactor passes
- [ ] The Static job passes (all `verify:static` subchecks + Dependency audit; if the audit fails due to a new upstream advisory, run `npm audit fix`, update and commit `package-lock.json`; do not change the audit threshold)

> CI Status Snapshot is a read-only observation of GitHub status
> (`authority: observation-only`), not authorization or a merge decision;
> merging still requires an explicit action.
