# Documentation instructions

[中文](AGENTS.zh-CN.md) · [Terms used](AGENTS.terms.yaml)

For documentation work in this directory, use
[`skills/doc-maintenance/SKILL.md`](../skills/doc-maintenance/SKILL.md) and read
the ownership rules in [README.md](README.md) or
[README.zh-CN.md](README.zh-CN.md).

Keep design intent, decision rationale, measured evidence, implementation status,
incident narrative, and unresolved work in their owning documents. Do not
duplicate an existing owner merely to preserve editing history; Git already does
that.

For an escaped failure, apply the [post-mortem triage
rule](postmortem/README.md#when-to-write-one). When it qualifies, write the
numbered record under `postmortem/` and add its index row.

NMG's repository collaboration surface is Agent-first:
the root `AGENTS.md` is the stable bootstrap, this file routes documentation work,
and `docs/README.md` owns document authority. Add another root entry only when it
prevents a named collaboration failure that these routes cannot cover; assign its
owner and verification contract before creating it.
