# Codex plugin sessions and self-contained distribution

[中文](2026-11-13-codex-session-adapter.zh-CN.md) · [Terms](2026-11-13-codex-session-adapter.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [capability assembly](../../design/unified-architecture/adapter-capability-assembly.md)

## Problem

Codex runs MCP processes and lifecycle hooks through separate connections.
A process-wide session override merges unrelated chats, while separate hook and
MCP identities break owner-state carriage and exact-evidence access. A plugin
that imports this checkout cannot be distributed independently.

## Decision

The Codex adapter declares its shared capabilities in the executable catalog.
Its native MCP envelope supplies thread and turn IDs. Hook admission records
the same IDs and absolute project directory. Model-authored arguments cannot
choose a session. The shared MCP tool implementation captures each request's
binding and cancellation signal with AsyncLocalStorage. Generic MCP retains its
existing configured-session behavior through the same tool factory.

The routing record holds up to 128 native turn scopes. Resume retains identity.
Forks receive distinct AGs. Clear changes the AG generation and fences old turns.
An operation already accepted by the daemon may finish in its captured old AG.
The daemon retains writer leases, evidence and maintained state. Missing hook
admission leaves explicit tools available with unknown project scope, except
after clear when a new admitted turn is required.

Hooks assemble shared recall, owner-state projection, observations, reminders
and prompt-time board batches. Owner state is prepared before optional recall.
Output acceptance precedes board receipts. Stop reports unknown processing state.
The binding supplies no answer-attribution or idle-wake event.

The build bundles a Node client, Skill and compatibility manifests into a local
marketplace package. Runtime dependencies are embedded. The closure check refuses
Store and NmgService imports. MCP uses a plugin-relative cwd and explicitly
forwards NMG data-directory and coordination settings. The client uses a compatible
daemon lease and clears its cached lease after RPC failure for the next request.
The installation guide owns commands and trust requirements.
[Codex package](../../../codex-plugin/README.md)

## Consequences

Native metadata support and reviewed hooks are host prerequisites. Each hook
invocation loads the small client and routing record. Abrupt host termination
uses registry heartbeat expiry. Routing files persist for resume and contain
identifiers and project paths. They contain no memory bodies or credentials.

Contract tests cover shared-connection isolation, foreign projection refusal,
generation fencing, complete state carriage and independent package startup.
The retained native probe installs an extracted archive in a private Codex home,
runs concurrent chats, resumes and forks against a local deterministic model.
Windows CLI execution is verified. Desktop GUI interaction, other operating
systems and natural model behavior remain outside that probe.
[Runtime evidence](../../experiments/runtime/codex-plugin-capabilities-2026-11-13.md)

## Alternatives considered

Process-wide identity cannot distinguish multiplexed native chats. Independent
hook and MCP identities require an extra cross-session projection protocol.
Source-bound installation requires every recipient to maintain this checkout.
Native request metadata and a bundled client fit the verified Codex entry points.
