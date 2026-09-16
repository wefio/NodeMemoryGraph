# Stable entry and local context discovery

[中文](2026-09-16-stable-entry-local-context.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

The root bootstrap duplicated development commands and carried adapter-specific
startup details. The development workflow required a routing command before every
edit, and documentation maintenance required reading the documentation index even
when the owner was known. These mandatory hops increased reading and maintenance
cost without establishing that the relevant contract had been understood.

## Decision

The [bootstrap](../../../AGENTS.md) owns a stable discovery protocol. Agents find
current structure through search, directories, and manifests, then read applicable
local instructions, the owning contract section, and the exact implementation.
The entry contains no module inventory or executable setup instructions.

The [development workflow](../../../skills/repo-development/SKILL.md#before-editing)
uses `agent:context` when ownership or checks are unclear. It retains verification
and coordination obligations; direct discovery does not require a routing command.
The [documentation workflow](../../../skills/doc-maintenance/SKILL.md#content-that-can-be-read-locally)
owns section scope, conditional links, and source-reference maintenance.

Operational instructions remain discoverable at their owners: formatting and
generated builds in the development workflow, and linked-profile startup in the
[DSH package README](../../../dsh/dsh-nmg/README.md#启动前构建). The hidden-feature
registration trigger lives in the development workflow; its rule remains in the
existing decision and its facts in the registry.

Required knowledge is recoverable from shared repository content or an explicit
shared task reference. Local indexes, memory, or a previous Agent are not required.
No harness integration, context compiler, new task store, or hand-maintained global
map is introduced.

## Alternatives considered

- **Put a small module map in the root entry.** Rejected: it duplicates changing
  structure and makes the entry another synchronization obligation.
- **Require a routing command or automatic harness injection.** Rejected as the
  default discovery prerequisite: ordinary search and reads must work, and harness
  changes are outside this task. Existing routing remains available as a helper.
- **Split every document or generate a second summary corpus.** Rejected: more
  files and derived prose can increase hops and drift. Only independently useful
  sections and existing owners are needed for this change.
- **Delete operational rules when shortening the entry.** Rejected: relocation
  preserves their applicable workflow triggers and package-level prerequisites.

## Consequences

The root entry stays independent of module moves and command changes. Agents still
have to choose relevant sections; repository prose cannot force loading or evict
previously read text. Link and document checks cover structural integrity, not
semantic completeness or real Agent performance.

## Deferred

A controlled fresh-session comparison of lookup calls, read volume, missed
constraints, and maintenance edits is not part of this documentation change.
No measured reduction in task cost or improvement in completion rate is claimed.
