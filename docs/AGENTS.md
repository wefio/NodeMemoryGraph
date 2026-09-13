# Documentation instructions

For documentation work in this directory, use
[`skills/doc-maintenance/SKILL.md`](../skills/doc-maintenance/SKILL.md) and read
the ownership rules in [README.md](README.md) or
[README.zh-CN.md](README.zh-CN.md).

Keep design intent, decision rationale, measured evidence, implementation status,
incident narrative, and unresolved work in their owning documents. Do not
duplicate an existing owner merely to preserve editing history; Git already does
that.

A failure that escaped and meets the [post-mortem triage
rule](postmortem/README.md#when-to-write-one) gets a numbered record under
`postmortem/`, with its index row.

Do not add conventional root community files such as `CODE_OF_CONDUCT.md` or
`CONTRIBUTING.md` by default. NMG's repository collaboration surface is Agent-first:
the root `AGENTS.md` is the stable bootstrap, this file routes documentation work,
and `docs/README.md` owns document authority. Add another root entry only when it
prevents a named collaboration failure that these routes cannot cover; assign its
owner and verification contract before creating it.
