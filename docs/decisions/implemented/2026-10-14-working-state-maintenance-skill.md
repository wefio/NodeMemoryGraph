# Working-state content maintenance as a small Skill

[中文](2026-10-14-working-state-maintenance-skill.zh-CN.md) · [Terms used](2026-10-14-working-state-maintenance-skill.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Daily work status](2026-10-12-working-state-daily-use.md)

## Problem

The working-state mechanism and shared policy do not explain how to choose and
retire content precisely enough to prevent deployment-log snapshots or premature
verification claims. The task-unit design supplies related semantics, but is long
and under governance review; the user permits reference, not a hard dependency.

## Decision

[Working-state maintenance](../../../skills/working-state-maintenance/SKILL.md)
owns a short content-maintenance procedure and review examples. It is usable
without reading the task-unit design. Existing NMG Skill routes reach it; the
fixed daily-status example is replaced by this workflow reference.

The procedure supplements, rather than replaces, the shared `memory_policy` and
AG operations. Existing task contracts retain authority over execution and
acceptance. The task-unit design is optional background, not a required read,
imported schema, or duplicated specification.

## Alternatives considered

- More runtime validation or a new state schema: unnecessary for this content
  workflow and unable to establish arbitrary prose as verified fact.
- Making the task-unit design mandatory: couples routine maintenance to a long
  document whose governance may change.
- Repeating the procedure in prompts and NMG manuals: creates multiple owners
  for rules that can be reached through one Skill.

## Consequences

No runtime, storage, tool, or prompt contract changes. Documentation checks can
validate the carrier and links; review examples do not establish natural Agent
adherence, host reload, model visibility, or accuracy/token benefits. Those need
separate evidence if evaluated.
