# Hidden Features Registry

[English](hidden-features-registry.md) | [简体中文](hidden-features-registry.zh-CN.md) · [Terms](hidden-features-registry.terms.yaml)

Living ledger: every capability that is not active by default (env-gated or mode
flagged) must have a row here, regardless of ownership or status. Rule:
`docs/decisions/implemented/2026-09-07-register-hidden-features.md`.

Keep this current in the same change that adds or alters a gate. Sweep method
(2026-09-07): grep `process.env.NMG_*` across `.pi/extensions/nmg`,
`dsh/dsh-nmg/src`, `src/` + the mode helpers in `src/integration/config.ts`
(they read via an `environment` parameter, so literal `process.env` scans miss
them).

## Feature register

Read the complete responsibility: [Feature register](hidden-features-registry/feature-register.md).

## Conventions

- Add a row in the same change that introduces a gate. Update the row on any
  change to a gate's name, default, owner, mode set, or status.
- A gate read through an `environment` parameter (not a literal `process.env.X`)
  still gets a row — those are the easiest to lose.
- "Planned / open" rows are allowed: intended capabilities that exist only as a
  dead link must stay visible so they cannot silently vanish again.
