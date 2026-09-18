# Builds and generated artifacts

Configure the formatting hook once per clone: `git config core.hooksPath .githooks`.
The pre-commit hook runs Prettier on staged `.ts` files.

Regenerable outputs are **not** tracked (see the rejected decision
[Track build artifacts in version control](../../../docs/decisions/rejected/2026-09-02-track-build-artifacts-in-git.md)):

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
   Before starting a linked DSH web profile, also follow the adapter's
   [startup prerequisites](../../../dsh/dsh-nmg/README.md#启动前构建).
3. `npm run check:lock` fails when the root `package-lock.json` drifted from
   `package.json`; fix with `npm install --package-lock-only`.

When a change touches a subpackage's `src/`, `package.json`, or its lockfile,
`npm run agent:verify` covers it through `verify:static` →
`verify:packages`/`check:lock`.
