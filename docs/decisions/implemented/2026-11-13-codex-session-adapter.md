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

Hooks assemble shared recall, owner-state projection, observations, reminders,
answer attribution and board batches. Owner state is prepared before optional
recall and carried after compaction. Interrupt cancels pending attribution.
Stop supplies the completed answer and can request one continuation for an
admitted board batch. Output acceptance precedes receipts and marks continuation
consumption even if receipt recording fails. Remaining notices wait for the next
native event. Processing is unknown at Stop, or busy when continuation is requested.

Shared MCP feedback submits explicit labels against the rated projection and
returns the daemon's training result. The versioned answer-attribution path
requires a daemon advertising `versioned-answer-attribution`. The adapter stores
up to 32 projection references per turn containing memory IDs and statement
hashes. The daemon checks live projection ownership and current content versions,
then derives diagnostic overlap using the recorded retrieval query. Existing
callers retain their ID-based path. Automatic overlap and explicit supervision
have independent semantics.

Codex Bash hooks can supply stdout with unknown execution outcome. A bounded
read of the native transcript resolves final status for the matching session,
turn and call. Only the tested native result header is accepted. Unsupported
formats retain unknown outcome. Per-call markers deduplicate final observations.
Hook RPCs share a four-second deadline within the five-second native handler.

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
identifiers and project paths. Diagnostic reference files are consumed at Stop
or interruption, while small per-turn cancellation/continuation markers persist.
Memory bodies and credentials remain outside these routing and reference files.

Fully idle background wake requires an additional host transport. Current
request hooks expose model-attempt diagnostics without complete provider input,
so final input confirmation remains unverified. Neither boundary requires
delegating existing native recall, state, feedback or completion handling to Magpie.

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
