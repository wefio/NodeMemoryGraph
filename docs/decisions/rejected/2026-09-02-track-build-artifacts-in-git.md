# Track build artifacts in version control

[中文](2026-09-02-track-build-artifacts-in-git.zh-CN.md)

**Status:** rejected  
**Date:** 2026-09-02

## Problem

The repository contains several regenerable outputs: `dsh/dsh-nmg/lib/` (tsdown
build output of the DSH host plugin), `src/prompts/nmg-prompts.generated.ts`
(emitted from `nmg-prompts.yaml` by `scripts/generate-prompts.ts`), and
`.nmg-search-scope` (a runtime hot-zone manifest). For a long time the working
tree carried modified-but-uncommitted copies of `lib/` and `package-lock.json`,
because PRs committed only `src/` while the tracked artifacts drifted behind.

That produced the worst of both worlds: artifacts were tracked (so a fresh clone
carried stale copies), yet never updated in step with their sources (so the
tracked copy was wrong and the tree was permanently dirty). The drift surfaced
as real failures — a stale `lib/index.js` that still spoke the old `anchors`
RPC surface while the daemon and CLI had already moved to `tesserae`.

## Proposal

Commit build artifacts (`dsh/dsh-nmg/lib/`, generated prompts) in the same
commit as their sources, keeping the repository always-buildable from a clean
clone and the tree permanently clean.

## Alternatives considered

- **Ignore the artifacts but keep them tracked as they are today.** Rejected:
  this was the status quo that produced permanent tree dirt and stale tracked
  copies — tracked yet never in step with their sources.
- **Generate into a separate location outside the repository.** Rejected for
  now: `dsh/dsh-nmg` is consumed by a `link:` install that expects `lib/` next
  to `package.json`; moving the output would break the DSH plugin contract.

## Why rejected

- **Generated outputs are not source.** They carry no design intent and cannot
  be reviewed meaningfully; a diff over `lib/index.js` is noise that obscures
  the real `src/` change.
- **They drift by construction.** Every artifact regenerates with a different
  timestamp/content hash per machine and toolchain version, so "commit them with
  every source change" is an unenforceable discipline that will silently lapse
  again (as it did before).
- **The right guarantee is buildability, not committed artifacts.** A clean
  clone must be able to regenerate everything — that is a _verification_
  property, owned by CI and the Repository Control Plane (`verify:packages`,
  `verify:static`), not a _content_ property of the tree.
- Lockfiles are the deliberate exception: `package-lock.json` / `pnpm-lock.yaml`
  pin the dependency graph and are configuration, not regenerable build output.
  They stay tracked, and drift between `package.json` and the lockfile is caught
  by `npm ci` and `check:lock`.

## Consequences

- `dsh/dsh-nmg/lib/`, `src/prompts/nmg-prompts.generated.ts`, and
  `.nmg-search-scope` are untracked and ignored.
- Fresh consumers of `dsh/dsh-nmg` must run `pnpm install --frozen-lockfile &&
pnpm run build` before the package is usable (see
  `skills/repo-development/SKILL.md`).
- CI verifies subpackage buildability from a clean checkout via
  `verify:packages`, so artifact exclusion cannot silently rot the build.
