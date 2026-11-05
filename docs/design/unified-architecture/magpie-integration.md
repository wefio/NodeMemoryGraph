# Magpie gateway integration

[中文](magpie-integration.zh-CN.md) · [Terms used](magpie-integration.terms.yaml)

**Status:** draft
**Authority:** [Harness integration](harness-integration.md#magpie-gateway-binding)

## Boundary and upstream interfaces

Magpie is an additional integration candidate at the model gateway boundary. It is not the Agent executor: a client Harness still owns tool declarations, tool execution and inference rounds. This binding can extend recall to clients behind Magpie without requiring a native NMG plugin in each client. It does not replace the pi durable cloud host.

The [community plugin repository](https://github.com/magpie-community/plugins#gateway-hooks) documents asynchronous Bun gateway hooks. The [released host contract](https://github.com/yetone/magpie/blob/v0.1.1273/docs/subsystems/gateway-request-hooks.md) defines `onRequest(body, ctx)` for context changes and bounded best-effort `onResponse(reply, ctx)` completion observation. `ctx.state` lasts for one request, not a durable conversation. The gateway rejects hook changes to tools, tool choice, model or stream settings. Pin the target Magpie version and check its contract during implementation; example memory plugins do not establish NMG compatibility.

Use a `magpie.hooks` package for asynchronous NMG service calls. The synchronous gateway middleware has a different runtime and must not be treated as that service client. A [tools plugin](https://github.com/magpie-community/plugins#tools-for-every-agent) exposes tools through Magpie's MCP server; alternatively the client can use NMG's MCP endpoint directly. Neither approach transfers execution ownership to the gateway hook. Installation and publication are separate work, not delivered by this design.

## Capability split

| Path | Intended capability | Boundary |
| --- | --- | --- |
| Gateway request hook | Bounded automatic recall and context injection | Observes model requests, not a complete Harness lifecycle |
| Completion hook | Optional observation/capture after a completed reply | Best-effort notification, not a durable queue or proof of memory use |
| Magpie tools plugin or NMG MCP | Explicit search, exact get and governed remember | Requires an actual client tool connection and authorized session binding |
| Optional plugin settings page | Endpoint configuration, recall/capture switches and connection test | No memory database, model loop or task scheduler |

Reuse NMG shared admission, query normalization, budgets and Agent Surface projections where their prerequisites hold. The binding translates supported request envelopes into those inputs and patches only the allowed context fields. Test Chat, Responses, Anthropic and Gemini separately; unsupported envelopes pass through without memory changes. Do not infer support from Magpie's ability to proxy a protocol.

Gateway-only recall provides self-contained, bounded authorized context using shared evidence projection after internal search/get. It must not instruct the model to call tools that the client has not connected. Compact headers plus follow-up IDs are appropriate only when the client's exact-get tool connection is established. Keep tool-call/result pairing, role boundaries and the original user text intact. Recalled evidence remains source material, not a new user instruction. Injecting evidence is not evidence that the model used or endorsed it.

## Identity, scope and consent

Use a host-configured authenticated endpoint: local daemon or the cloud memory service. The plugin does not open SQLite, select a second backend or start/stop the shared daemon. Preserve the [shared endpoint rules](harness-integration.md#host-capabilities-and-endpoint-selection); a remote failure cannot send data to an unrelated local store.

Magpie's origin, agent, session and working-directory metadata help admission and attribution but do not authenticate a tenant. Model names and provider accounts are not memory namespaces. Admit requests only under a verified endpoint credential and an explicitly configured scope. Skip non-local/unknown origins by default; additional gateway keys or remote clients require explicit authorization and namespace binding. Revalidate against the target release rather than assuming all origin enum values from older examples remain complete.

A missing or unstable session ID does not justify creating shared session state from the model name, current directory or an empty key. In that case restrict the binding to authorized stateless recall, or skip it. Session AG writes, attribution and tools that need invocation fences remain disabled until an authentic per-client/session binding is available. A tools plugin's generic `execute(args)` example alone does not prove that it receives the originating Harness session; do not join an MCP tool call to a concurrent gateway request by guessing.

Recall and capture have separate consent. Capture defaults off. Even read-only recall sends a query to the selected service; remote query export requires an explicit configured connection. Send only the bounded text and provenance needed for that operation, not complete histories, system instructions, hidden reasoning, credentials or tool bodies by default. The settings/test path names the service and scope without sending a real conversation or writing memory.

## Request and completion behavior

For an admitted request, select the original tenant/session/endpoint binding before recall, derive a bounded query and preserve that mapping in private request state for completion. Do not resolve the completion against a different account because routing or settings changed. A change that revokes permission prevents completion capture rather than switching the destination.

Detect user-turn admission separately from tool continuations, helper calls and inference retries. Repeated model requests do not necessarily represent new user turns. Claim turn-level deduplication only when the host supplies a stable identity or the binding has a validated equivalent; a text hash alone can collapse legitimate repeated user messages. Stateful Responses continuations need explicit validation; when the gateway cannot observe sufficient context, skip injection rather than inventing a transcript.

Recall obeys the gateway deadline and cancellation signal, with bounded response bytes and a per-endpoint failure backoff. On timeout, authorization failure or invalid memory output, leave the provider request unchanged and report a fixed status without content or credentials. This failure behavior applies to optional automatic recall; explicit memory tools return their actual errors and never pretend a failed write succeeded. A hook must not delay or replace a model reply that the client already received.

`onResponse` can report incomplete or unsuccessful replies and can be discarded on shutdown. It is not a durable capture mechanism. With capture explicitly enabled, retain admissible source evidence through the existing history/import profile; observing text is not permission to create Agent-confirmed semantic facts. Response success is neither positive feedback nor confirmation of a recalled claim. Recheck capture consent and the original scope before exporting anything.

Best-effort capture reports only confirmed acceptance; it does not promise complete conversation history. Do not blindly retry a non-idempotent write. Loss-free capture would require a separately designed durable handoff with operation IDs and replay evidence. Explicit memory tools follow the [external-effect contract](harness-integration.md#external-effects-and-recovery) when their host can persist invocation identity; otherwise unresolved outcomes require reconciliation.

## Coexistence with native adapters

Select one automatic recall/capture owner per Harness session. A client using a native NMG plugin or the pi durable binding can exclude that session from Magpie hooks. Share a verifiable disclosure key when both paths must coexist; two independent process-local deduplication caches are not sufficient. Do not add the same explicit tools through both Magpie and direct NMG MCP without a deliberate name/ownership choice.

Gateway integration does not advertise idle wake, interactive host commands, durable checkpoints or NMG task coordination solely because the gateway can observe traffic. Local board access, if separately requested, needs its own supported client/session contract; it is outside the first Magpie memory integration slice. The [capability matrix](../harness-capability-matrix.md) records a Magpie column only after delivered behavior has scoped evidence.

## Validation and open implementation work

Use a fake NMG service and recorded protocol fixtures before live deployment. Required cases cover:

- Request admission, no-identity behavior, tenant/session isolation, endpoint changes, revoked consent and remote-origin opt-in.
- Each supported request protocol, user/tool/helper continuations, retry identity, tool-call pairing and untouched unsupported envelopes.
- Bounded authorized recall with and without a confirmed exact-get tool connection; timeout/cancellation/failure leaves the original request intact.
- Streaming completion, partial/failed replies, dropped completion notifications and capture-off read-only behavior.
- Native-plugin coexistence, duplicate request handling, withdrawal rechecks and no inferred positive feedback.
- Tool schema and Agent Surface parity, argument validation, actual MCP client/session binding and unknown write outcomes.
- Plugin reload and real target Magpie/Bun startup, configured local/cloud connectivity, and settings changes without conversation export during tests.

The exact package layout, target release, origin/session guarantees, supported protocol subset and MCP session mapping remain to be validated. This design adds an integration candidate, not an installed plugin or a shipped capability.
