# Magpie interfaces and adapter cooperation

[中文](magpie-capabilities.zh-CN.md) · [Terms](magpie-capabilities.terms.yaml)

**Status:** draft
**Authority:** [Magpie integration](magpie-integration.md)

## Integration choices

Compose Magpie with the client's whole connected capability set: native
adapters, MCP, hooks and CLI/Skill access. The shared
[composition model](harness-integration.md#compose-capabilities-across-connected-entry-points)
selects providers per operation. Gateway recall plus MCP tools is a candidate
for a combined memory flow without a native plugin. Pi is a separate candidate
for tracing native recall through gateway routing using an explicit trace join.

The interface review targets Magpie `0.1.3545`, observed locally on 2026-11-12.
The versioned sources below establish available interfaces, not a working NMG
integration. No plugin loading, collector export, real model request or combined
NMG/Magpie session was exercised. NMG source links describe wiring rather than
deployment. The [operations plan](magpie-operations.md) owns delivery slices.

## Choose the interface by observation

| Need | Versioned upstream source and surface | Integration consequence |
| --- | --- | --- |
| Read/modify the model context | [Gateway hooks](https://github.com/yetone/magpie/blob/v0.1.3545/docs/subsystems/gateway-request-hooks.md), [context definition](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/gateway.go) | Async Bun `onRequest` can await bounded NMG reads. It receives origin, protocol, requested model, stream, path, agent, session, cwd and query. It runs before routing, so requested model is not the final provider/model. Tools and tool choice remain client-owned. |
| Observe completed replies | The same request-hook contract | `onResponse` receives the reconstructed client-facing reply and completion status. It cannot rewrite the delivered reply and can be lost. It supplies neither native tool execution nor Agent idle state. |
| Show aggregate usage | [Page bridge](https://github.com/yetone/magpie/blob/v0.1.3545/internal/gui/pluginpage.go) | Declared `usage:summary` reads cover today/7d/30d calls, errors, input/output, cache reads, cost and a bounded model summary. They do not provide session-level attribution. `usage:day` has its own day view. |
| Observe usage rows | [Middleware extension](https://github.com/yetone/magpie/blob/v0.1.3545/internal/middleware/points.go) | `onUsage` runs synchronously in moejs, separately from Bun. Rows include provider/account, caller/provider key IDs and names, requested/served model, token categories, timing, attempts, status and cost. They omit session, request ID, prompt and raw credentials. |
| Join an individual model request | [OTLP request spans](https://github.com/yetone/magpie/blob/v0.1.3545/internal/otlp/request.go) and [reference](https://github.com/yetone/magpie/blob/v0.1.3545/docs/reference.md) | Valid incoming W3C version-00 `traceparent` joins the caller trace. Gateway parent spans contain routing-attempt children, including failed attempts and fallback. Usage belongs to the children. Native tool execution needs separate caller spans. |
| Place NMG UI in the existing window | [Page/panel declarations](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/page.go) | An independent page can have a host service. Panels have agents/usage/settings/provider slots. Provider/agent menu actions open the plugin page with an ID/name. Panel transport still needs its own validation. |
| Use embedding and rerank providers | [Retrieval API reference](https://github.com/yetone/magpie/blob/v0.1.3545/docs/reference.md) | `/v1/embeddings` accepts OpenAI-shaped inputs, `/v1/rerank` accepts supported retrieval-vendor shapes. Both use a gateway key and provider/model or bare model ID. Provider compatibility and NMG index identity need tests. |
| Distribute explicit tools | [Plugin tools](https://github.com/yetone/magpie/blob/v0.1.3545/docs/subsystems/plugin-tools.md) | Streamable HTTP `/mcp/magpie/tools` exposes plugin-prefixed tools. Execution context exposes gateway-known agent, abort and host directory. That does not establish a native Harness session binding. |

`onUsage` is an optional bounded observer. Its queue holds 1,024 rows and a
callback has a 250 ms limit, with drops possible. It is unsuitable as the sole
durable usage ledger or a per-recall join. Do not assume arbitrary Node imports
or asynchronous NMG RPC in that runtime. Persistent transport needs a supported
export or bridge.

OTLP export requires collector configuration. The exporter can suppress gateway
spans when its native transcript tracing already covers the agent/session.
Validate that deduplication path before promising a complete waterfall.
`traceparent` is an observation link, not session authentication.

Static plugin frames cannot access arbitrary network endpoints. Bridge reads
are declared, `providers:list` exposes provider IDs/names rather than keys or an
embedding-model catalog, and plugin options are not secret storage. Custom NMG
metrics and operator writes use a supported host service. With `magpie web`,
service access uses the host reverse proxy rather than the viewer's localhost.

## Complement existing NMG adapters

All gateway contributions below require the client's model traffic to actually
pass through Magpie. Direct traffic and switch-only configurations are outside
that coverage. Matching a display name alone cannot join sessions.

| Adapter and source entry | Existing native contribution | Magpie contribution and boundary |
| --- | --- | --- |
| [Pi](../../../.pi/extensions/nmg/index.ts), [timing](../../../.pi/extensions/nmg/first-response-timing.ts) | Recall preparation, tool-result observations, compaction, completion and session lifecycle. Pi already observes Assistant usage and provider/first-response timing. | Add gateway-internal provider/account selection, routing attempts, fallback and billing/cache observations. Test outgoing `traceparent` through `before_provider_headers` and OTLP. Preserve native recall ownership. |
| [DSH host package](../../../dsh/dsh-nmg/src/plugin/index.ts) | Inbox-triggered recall, actual native Agent/session identity, busy declarations, disposal, child resume and wake delivery. Recall token totals are estimates. | Add actual upstream usage, route outcomes and a cross-Harness operations view. Gateway silence cannot replace native busy/disposal/child lifecycle. |
| [DSH legacy](../../../dsh/nmg-plugin.mjs) | `agent/pre-step` invokes `onPreStep`, admits a recall turn and appends fresh candidates to the entering decision. It also exposes memory tools. | It already has automatic recall. Use gateway observations alongside that path, not another injection. Keep it distinct from the host package's inbox/session integration. |
| [OpenCode v2](../../../opencode-plugin/index.ts) | Prompt/context recall, tool observations, compaction and event-mapped sessions. Completion uses execution events rather than a guaranteed idle event. | Add request/route outcomes and actual upstream usage. An HTTP success is not native execution completion. Provider-header propagation is not established by this adapter's current host contract. |
| [WorkBuddy hook](../../../workbuddy-plugin/nmg-hook.ts) and [MCP separation](../../../workbuddy-plugin/README.md) | UserPromptSubmit preparation, a namespaced hook session and limited tool nudges. Hook output alone does not confirm model delivery. | A gateway hook can check the submitted model envelope for the prepared disclosure and observe completion/usage. That proves gateway receipt at most. It does not merge the separate hook and MCP AG sessions or prove memory use. |
| [MCP-only clients](../../../claude-plugins/nmg-memory/agents/memory-copilot.ts), including clients using this server from Codex or Claude Code | Explicit search/get/remember and fenced state tools. No native user-turn or automatic recall hook. | An authorized, stable client/session binding can add gateway automatic recall while MCP keeps explicit tools. Without that binding, restrict to authorized stateless recall or skip. Do not manufacture idle wake or tool execution observations. |

Pi's SDK dependency is declared in [package.json](../../../package.json).
The inspected SDK `BeforeProviderHeadersEvent` permits mutation of outgoing
headers. The existing NMG timing handler only observes this hook. Implementing
trace propagation still needs tests against the supported SDK/provider path.

The proposed [pi durable binding](harness-integration.md) is a separate cloud
execution design, not another shipped adapter. Checkpoints, sleep and durable
task execution stay with that host. A gateway cannot supply those semantics.

## MCP plus Magpie as one session

This draft combines providers at the shared service. It does not require the
gateway to push events through MCP or a native plugin to exist first.

| Capability | Contribution to the composed session | Remaining condition or gap |
| --- | --- | --- |
| Automatic recall | Magpie request admission triggers shared recall and context injection | Validate protocol and new-turn versus continuation/retry recognition |
| Exact evidence and memory writes | Existing MCP search/get/remember tools | Bind the tool connection to the same authorized conversation generation |
| Disclosure and budget continuity | Shared InformationView, service-owned disclosure state and access checks | Establish cross-entry handoff; independent AG IDs are not interchangeable |
| Working state and coordination | MCP state tools provide explicit reads/writes; gateway can prepare authorized pending context | Respect endpoint capability and local-only board boundaries; model reads are pull, not idle push |
| Tool observations | MCP server knows its own tool executions; gateway may see submitted tool-result messages | Other tools need native witnesses; protocol content alone is not verified execution |
| Completion and feedback | Gateway observes completed responses; explicit MCP operations can submit permitted feedback | Completion is best effort and is not positive feedback or confirmation |
| Usage and UI | Gateway usage/trace plus Magpie panels over NMG metrics | Join only with validated correlation and preserve accounting scope |
| Idle wake, reset and durable recovery | Use another connected provider if available | MCP plus model-request hooks alone do not establish these capabilities |

A candidate handoff proceeds as follows:

1. Host configuration or an authenticated service handshake binds gateway and
   MCP connections to the same scoped conversation generation. Model-supplied
   session IDs alone cannot establish it. Binding issuance, expiry and reconnect
   handling need implementation and isolation tests.
2. On an admitted model request, the gateway calls shared recall. The service
   prepares InformationView context and permitted follow-up references, retaining
   disclosure state and distinguishing prepared context from confirmed delivery.
3. If the model needs full evidence, it uses the existing MCP `get` surface.
   The service resolves the authorized projection for that binding and checks
   current access, source revision and budget. Cross-entry resolution is design
   work, not an ability of today's unrelated MCP and hook AG sessions. Without
   it, use self-contained gateway context or a fresh MCP search.
4. MCP writes return normal service receipts. A later gateway request observes
   the shared state under current authorization. Operation identity and effect
   reconciliation prevent retries or provider changes from duplicating effects.

These providers compose a broader memory workflow, with explicit lifecycle gaps.
Test interleaved clients, forks, reset/reconnect, withdrawal, concurrent state
writes, budget continuity and duplicate injection before claiming coverage.
If another provider supplies a missing capability, add it to the same set and
validate the handoff rather than introducing another parallel session system.

## Reuse the embedding transport before duplicating credentials

NMG's [OpenAI provider](../../../src/core/embedding-providers/openai.ts) already
accepts a base URL, key and model. Test it with Magpie's embeddings route and a
restricted gateway credential. Upstream vendor credentials can remain owned by
Magpie. A direct NMG provider remains an alternative when that route is absent
or incompatible. The GUI must distinguish these credential owners.

Pin the provider/model and compatible routing configuration for each index.
Bare-model automatic grouping or fallback across incompatible models can mix
vector spaces. Check dimensions, document/query profile, templates and
[index namespace](../../../src/core/openai-embedding.ts), including whether an
endpoint change needs a new namespace. Do not assume a changed URL creates a
distinct index identity automatically.

Magpie's rerank endpoint is an available upstream transport, not an existing NMG
reranker or evidence of better Recall@20. If adopted, integrate it into shared
retrieval at the intended candidate-selection stage, with separate quality,
latency, cost and failure-mode measurements.

## First integration proofs

Keep the GUI-first delivery order. Within that work, use aggregate bridge reads
for the initial usage panel and NMG service snapshots for store metrics. Do not
promise per-recall billing from `onUsage`.

Next validate two bounded paths independently:

1. Pi native recall remains the owner. Join a caller trace to gateway attempt
   spans, verify SDK header propagation, collector export and transcript dedup,
   and show where latency and token reports originate.
2. One explicitly bound MCP-only client receives gateway recall through shared
   InformationView. Verify protocol shape, session isolation, disclosure
   deduplication and exact-get ownership before widening coverage.

Embedding transport can be tested with protocol fixtures in parallel with the
panel work. Real provider requests, collector enabling and deployment require
their own execution scope. None is necessary to accept this interface map.
