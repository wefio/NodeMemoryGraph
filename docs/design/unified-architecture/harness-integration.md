# Harness integration for local hosts, pi durable and Magpie

[中文](harness-integration.zh-CN.md) · [Terms used](harness-integration.terms.yaml)

**Status:** draft
**Authority:** [Unified architecture](../unified-architecture.md#shared-harness-integration)

## Responsibility and ownership

The NMG shared integration layer handles recall, disclosure, feedback and session fencing. The host Harness owns the Agent/model/tool loop and its execution lifecycle. pi durable is the selected cloud host; its NMG extension is the host binding. Selecting this host does not establish integration or deployment evidence.

Compose the existing [shared session flows](../../decisions/implemented/2026-10-16-shared-session-flows.md), [Agent Surface](../../../src/integration/agent-surface.ts), [state interface](../../../src/integration/state.ts) and transport implementations rather than creating another tool schema or scheduler. Shared code accepts endpoint, identity, capabilities, deadlines and a host-owned integration-state port. Bindings translate native events, register native schemas from shared tool definitions, inject context and render host UI. They never open a memory Store.

| Owner | State and operations |
| --- | --- |
| Harness | Conversation history, Agent execution, tools, execution checkpoints, retries, cancellation and durable wake scheduling |
| NMG shared integration | Recall flow, bounded turn/task windows, disclosure/feedback bookkeeping, session binding, deadline propagation, connection reuse and cleanup |
| Memory application service | Admission, memory operations, session Active Graph, authorized disclosure and attribution through a trusted tenant/session binding |
| Memory backend | Durable domain records, graph structure, indexes and commit receipts under the storage contract |
| Local coordination service | NMG board/task/run state and delivery protocols; unavailable on the cloud memory endpoint |

The Harness transcript/checkpoint store and NMG memory store have separate owners and transactions. pi durable may use SQLite for its own execution state while NMG selects either memory backend. A host's durable task or child Agent is not an NMG Task Board entry. Preserve the distinction between Agent execution and graph organization.

## Host capabilities and endpoint selection

Capabilities reflect actual behavior: before-turn interception, context injection, tool-result observation, idle wake and interactive commands. Unsupported capabilities remain explicit. A passive hook can expose only injection, and MCP need not invent a before-turn event. An enqueue receipt follows host acceptance, not Agent comprehension.

Local bindings use the local daemon contract. The pi durable binding uses a configured authenticated cloud memory endpoint with the same memory semantics and model-facing tool surface. Endpoint credentials and tenant identity are host-controlled, not model-authored parameters. The endpoint validates tenant/session ownership before resolving any IDs. A cloud failure never falls back to an unrelated local database or another tenant.

Preserve the [adapter recipe](../../../skills/nmg-memory/references/harness-adapters.md)'s daemon non-ownership, session-state fences and allowed fallback rules. Cloud-only bindings do not discover or start a local daemon, and do not advertise NMG board/run or local wake capabilities. Private session AG operations can be exposed only when the cloud service implements their ownership and fencing contract. Host-owned pi durable scheduling remains available independently.

The [capability matrix](../harness-capability-matrix.md) owns delivered coverage. It gains pi durable or Magpie columns only when adapters are implemented with scoped evidence; the target design is not a claim of shipped coverage.

## Magpie gateway binding

The [Magpie integration design](magpie-integration.md) adds a gateway candidate alongside native Harness bindings. It separates request-hook recall, best-effort completion observation and explicitly connected memory tools. Magpie remains a gateway; its client owns Agent execution. Identity, protocol coverage and coexistence with a native NMG plugin require validation before enabling this path.

## Compose capabilities across connected entry points

Treat the client's configured native adapter, MCP connection, passive hooks,
CLI/Skill access and other supported bindings as one available capability set.
Magpie contributes to that set. Select providers per capability and operation,
not one adapter for the whole session. A client can use gateway turn preparation
and delivery, MCP exact reads and writes, native tool witnesses and shared AG
state carriage. Neither MCP nor Magpie has to supply the whole flow.

Measure composition by NMG feature parity: search/exact evidence, governed
memory lifecycle actions, recall, maintained-state carriage, disclosure/budget
continuity, supported attribution/feedback and board collaboration. Use the same
end-to-end contract cases across providers. GUI, usage and transport tracing
are independent enhancements and do not count as closing these feature gaps.
Match operation semantics and evidence quality, not interface appearance.

A provider's implementation is independent of its selection in a session.
Complete providers can overlap. Selecting native recall or tools does not trim
the Magpie plugin to a residual subset; its
[standalone surface](magpie-integration.md#complete-plugin-and-per-session-activation)
remains independently usable. Track capability, enablement and operation
ownership separately, and test standalone providers as well as combinations.

Record each gap as missing NMG implementation, an unverified host path or an
explicit host restriction using the [owning matrix](../harness-capability-matrix.md#native-host-capability-findings).
DSH/OpenCode context and tool/event contracts provide native paths. Native
work and complete Magpie support can proceed independently; unfinished native
wiring does not make a gateway necessary.

The target is the greatest verified coverage the connected set can provide.
Retain stronger native capabilities and explicit remaining gaps. A CLI/Skill
instruction can enable explicit action but cannot create an automatic event.
Two partial implementations establish a combined capability only when their
handoff is supported and tested. The draft
[MCP plus Magpie composition](magpie-capabilities.md#mcp-plus-magpie-as-one-session)
describes one such handoff without requiring a native plugin.

For each enabled capability, identify its provider, trigger, scope, evidence
strength and fallback. Shared integration selects one side-effect owner per
operation and permits additional observers. Recall preparation, delivery,
explicit tools and optional capture can have different owners. Re-selecting an
owner after disconnect or reconnect must reconcile accepted effects before
repeating them. Missing delivery evidence remains unknown.

Composition requires a trusted mapping to the same endpoint, tenant, memory
scope, conversation generation and applicable operation/disclosure identity.
Transport connections can stay separate. AG access and writer fences remain
service-controlled; a model-visible memory reference is not authority to borrow
another connection's AG. The concrete binding handshake is implementation work.
Unauthenticated matching by prompt text, directory, model or display name cannot
establish the mapping. Authorization boundaries, including local-only board
access, remain in force across all contributors.

The resulting capability description belongs to the bound session, while the
adapter matrix continues to describe individual providers. Verify combinations
and their gaps as well as individual adapters. No new scheduler or second
memory/state store is needed to express this composition.

## Cloud memory API

The cloud application boundary serves the shared memory DTOs and Agent Surface through authenticated HTTP. Its required surface includes search, exact get/evidence, governed remember/batch/resolution, and the session disclosure/attribution operations needed by enabled recall features. It enforces the [storage contract](../unified-architecture.md#storage-contract) on writes and advertises only implemented capabilities. Tool names and fields remain shared even when local and remote routing differ.

The existing [AML service](../../../onlion/backend/memory-service.ts) supplies an import/search application profile. Its Add/Search envelope alone does not establish the full interactive memory interface. Preserve AML's import semantics at its own boundary; route the interactive surface and AML through the same engine without treating imported history as Agent-confirmed statements.

The cloud session owner may outlive an HTTP invocation. Its lifecycle must retain or deliberately invalidate AG/disclosure handles and leases; session-state writes are not implemented by opening a fresh unrelated session on every request. A service restart can expire a handle and return a typed refusal. The binding re-establishes an authorized session and performs a fresh read; it never borrows a newer writer fence to replay an old mutation.

## pi durable binding

The [upstream pi durable contract](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) provides extensions with tools, sections, hooks and tasks. Use those mechanisms for NMG registration and context delivery. pi durable remains the executor. Register the NMG extension on every host open because stored extension names do not recreate the process registry. Pin package versions and verify the selected hooks before implementing the mapping; do not assume Pi terminal extension compatibility.

Bind authenticated tenant, stable conversation identity, branch/reset generation, admitted turn and tool invocation to the NMG session. Reopening the same conversation keeps its binding; forks and resets establish a distinct generation under the session contract. A process ID, transient request ID or reconnect count is not a conversation identity. Persist only the minimal mapping needed for this attribution, not a second transcript.

Persist NMG integration state through a host-owned port. Local hosts can use appropriate session state; pi durable uses committed conversation documents or task checkpoints. Store the completed disclosure/feedback status and pending operation identities needed to resume. Persist no credentials or backend read handles in model-visible state. Ordinary connection caches remain disposable. Recovery must not treat an empty process-local cache as proof that recall, injection or feedback never happened.

Recall and context delivery form a recoverable sequence: identify the turn, fetch bounded memory, prepare the host context, then commit host delivery and the integration marker together where the host supports that commit. If the selected hook cannot make them atomic, define an idempotent delivery key accepted by the host and test the crash window. Do not advertise duplicate-free injection using a marker written separately after an external effect. If a replay observes a newer memory revision, either reuse its persisted prepared context under current authorization or explicitly start a new disclosure generation; do not merge the two observations silently. Expired or withdrawn memory is revalidated before any new disclosure.

## External effects and recovery

pi durable's recovery does not make a remote NMG write atomic with the Harness checkpoint. A phase may repeat after a crash. The binding and cloud service implement the following protocol without a distributed transaction:

1. Derive and persist a stable operation ID from the trusted conversation generation, invocation and operation slot before sending the request. Canonical request content remains the same across retries. Reuse with different content fails.
2. Send that ID through the cloud application to the storage commit/receipt path. The server validates and namespaces it; it does not accept a model's choice of another tenant or arbitrary idempotency identity.
3. Once the memory service returns a committed receipt, save the receipt and tool result in a host commit. If the process dies between remote commit and host commit, retry the same operation and recover the recorded receipt.
4. A timeout or cancellation means unknown remote outcome until receipt lookup or an idempotent retry resolves it. Do not report rollback because the client stopped waiting. A host commit never claims that an unconfirmed remote memory write succeeded.

Read retries can execute again under their read contract. Writes, attribution/feedback and state changes require their own explicit duplicate policy; the admission `requestId` alone is not proof that every nested external effect runs once. The idempotency retention window must cover the supported durable replay horizon. If it expires, stop an unresolved replay for reconciliation rather than assigning a new operation ID and risking duplication.

Deadlines and abort signals propagate to remote calls. pi durable owns sleeping, alarms and resume; an NMG recall or polling loop must not keep a sleeping host alive. A cancellation, session change or host restart discards obsolete in-process work. Closing the binding releases its own connections and read resources without shutting down shared services. Version upgrades must preserve or migrate durable integration state and stable operation keys; do not replay old work under changed semantics without a migration decision.

## Validation before enabling the binding

Use deterministic model stubs first; no online model or provider spend is required for the contract tests. Pin pi durable and endpoint versions, then demonstrate:

- Tool registration, bounded recall/context injection and evidence disclosure for the same shared surface used by a local host.
- Reopen, fork, reset and tenant isolation, including expired AG handles, stale writer fences and withdrawn evidence.
- Process termination after remote commit but before host checkpoint, lost replies, same-ID content conflicts and expired idempotency windows.
- Crash around context injection and feedback delivery, with exactly one accepted effect under the chosen delivery protocol.
- Cancellation, deadline expiry, unsupported capabilities, registry recreation and durable integration-state migration.
- Actual target deployment boot, memory API authentication and native-backend runtime placement; a host that runs in a Worker does not prove that a native retrieval library can run there too.

Only these scoped results can establish adapter capability coverage. No pi durable adapter, cloud interactive API, crash test or deployment is delivered by this document.
