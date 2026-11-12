# Magpie interfaces and adapter cooperation

[中文](magpie-capabilities.zh-CN.md) · [Terms](magpie-capabilities.terms.yaml)

**Status:** draft
**Authority:** [Magpie integration](magpie-integration.md)

## Integration choices

Compose Magpie with the client's whole connected capability set: native
adapters, MCP, hooks and CLI/Skill access. The shared
[composition model](harness-integration.md#compose-capabilities-across-connected-entry-points)
selects providers per operation. The target is normal use of NMG features across
adapters: memory operations, automatic recall, working state, disclosure,
attribution/feedback and coordination. Usage, tracing and GUI are additional
Magpie features; they do not close an NMG capability gap by themselves.

Target: Magpie `0.1.3545`, observed locally on 2026-11-12. Versioned sources
establish interfaces, not integration. Plugin loading, collector export, model
requests and combined sessions were not tested. NMG links describe wiring,
not deployment. The [operations plan](magpie-operations.md) owns delivery slices.

## Choose the interface by observation

| Need | Versioned upstream source and surface | Integration consequence |
| --- | --- | --- |
| Read/modify the model context | [Gateway hooks](https://github.com/yetone/magpie/blob/v0.1.3545/docs/subsystems/gateway-request-hooks.md), [context definition](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/gateway.go) | Async Bun `onRequest` can await bounded NMG reads. It receives origin, protocol, requested model, stream, path, agent, session, cwd and query. It runs before routing, so requested model is not the final provider/model. Tools and tool choice remain client-owned. |
| Observe completed replies | The same request-hook contract | `onResponse` receives the reconstructed client-facing reply and completion status. It cannot rewrite the delivered reply and can be lost. It supplies neither native tool execution nor Agent idle state. |
| Show aggregate usage | [Page bridge](https://github.com/yetone/magpie/blob/v0.1.3545/internal/gui/pluginpage.go) | Declared `usage:summary` reads provide today/7d/30d aggregates, not session attribution. `usage:day` has a separate day view. |
| Observe usage rows | [Middleware extension](https://github.com/yetone/magpie/blob/v0.1.3545/internal/middleware/points.go) | `onUsage` runs synchronously in moejs, separately from Bun. Rows include provider/account, caller/provider key IDs and names, requested/served model, token categories, timing, attempts, status and cost. They omit session, request ID, prompt and raw credentials. |
| Join a model request | [OTLP spans](https://github.com/yetone/magpie/blob/v0.1.3545/internal/otlp/request.go) | W3C version-00 `traceparent` joins the caller trace. Routing-attempt children carry failures, fallback and usage. Native tools need caller spans. |
| Place NMG UI | [Page/panel declarations](https://github.com/yetone/magpie/blob/v0.1.3545/internal/plugin/page.go) | Independent pages can have services. Panels have agents/usage/settings/provider slots. Menu actions open pages with ID/name. Validate panel transport separately. |
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

Gaps describe NMG wiring, not host inability. Separate missing implementation,
unverified host paths and explicit host restrictions under the
[matrix findings](../harness-capability-matrix.md#native-host-capability-findings).
DSH means the current host package; the historical preset is not a parity target.
For DSH/OpenCode, use existing native context/tool/event hooks first where they
fit. Magpie retains its complete implementation as an independently usable
provider, not a requirement for unfinished native wiring.

| Adapter and source entry | NMG gap to close | Candidate combined NMG behavior |
| --- | --- | --- |
| [Pi](../../../.pi/extensions/nmg/index.ts) | Broad native coverage, but prepared per-turn working state has no final input confirmation. | Keep native recall/tools/witnesses/wake. At the gateway boundary, check the labelled current state/disclosure and repair missing context through shared preparation where authorized. Do not claim an already-covered tool or recall as a new capability. |
| [DSH](../../../dsh/dsh-nmg/src/plugin/index.ts) | Complete state carriage, tool observation/nudges and committed-turn diagnostic attribution use native hooks. Installed-core and private fixture checks cover this slice; live wake and lifecycle edges remain unverified. | Keep native ownership where selected and validate remaining boundaries. Magpie retains independently usable request-bound equivalents. |
| [OpenCode v2](../../../opencode-plugin/index.ts) | Native state carriage and first-turn scope lookup pass an installed-host loopback run with NMG tools. Witness lineage and live wake remain unverified. | Keep native context/tool/event paths where selected. Magpie remains a full alternative provider and can repair authorized request-time gaps after shared handoff validation. |
| [WorkBuddy hook](../../../workbuddy-plugin/nmg-hook.ts) + [tool path](../../../workbuddy-plugin/README.md) | Hook recall and MCP tools use separate AG sessions. No demonstrated continuous state carriage, general tool observations or automatic attribution. | Bind hook/MCP/gateway state, then support recall-to-get, maintained-state carriage, request-visible observations, diagnostic attribution and pending-board context. Supply MCP tools if absent. Keep hook recall when selected; no duplicate injection. |
| [MCP-only clients](../../../claude-plugins/nmg-memory/agents/memory-copilot.ts) | Missing recall, state carriage, automatic attribution and request-time board delivery. Feedback is named in the action enum but lacks labels/dispatch. | Gateway supplies request-triggered parts; shared tool wiring must complete feedback and provide reads/writes/state. Bind both paths to one authorized session. Other providers can supply lifecycle events. |

These are source-grounded gaps and proposed closures, not shipped combined
coverage. The [adapter matrix](../harness-capability-matrix.md) owns delivered
coverage. In particular, state read/write support does not prove state carriage.
The [carriage contract](../session-active-graph-runtime-design.md#dedicated-state-carriage)
separates preparation, transport and confirmation.

### Shared mechanisms for feature parity

Use the same mechanisms across all combinations:

- Expose missing memory/state/feedback operations through shared Agent Surface
  tools in a client-connected MCP server, including Magpie's tools path if
  selected. A hook cannot add tool schemas to a request or call tools on the
  client's behalf. Avoid duplicate tools when native equivalents exist.
- Prepare current working state, recall and pending notices under the shared
  InformationView budget and their distinct carriage rules. Preserve protected
  state fragments and apply disclosure deduplication. Re-prepare after context
  loss only with a current binding; do not indiscriminately reinsert every call.
- Feed request-visible tool results into shared AG observation/nudge flows as
  reported evidence. Use native execution witnesses where available. Run
  diagnostic answer-overlap attribution only for the bound disclosure and a
  corresponding complete reply; it is neither correctness nor training feedback.
- Deliver pending board context on the next admitted request if native delivery
  is absent. Keep batch selection, subscriptions and receipts in the shared
  board flow. Request-time delivery is not an unsolicited idle-Agent wake.

Measure parity by end-to-end NMG tasks: recall then exact get, write/update and
forget, state write then later carriage, attributable evidence/explicit feedback,
and board batch read/reply. Use the same contract cases across adapters, with
each missing lifecycle behavior recorded separately.

The proposed [pi durable binding](harness-integration.md) owns cloud checkpoints,
sleep and durable execution. It is not a shipped adapter or a gateway capability.

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

Keep the [GUI-first delivery order](magpie-operations.md#delivery-order-and-acceptance).

Validate the NMG gaps in the adapter table using shared contract cases. Prioritize
DSH/OpenCode lifecycle and wake boundaries, hook-to-tool continuity for WorkBuddy,
missing tools for partial clients, and request-triggered NMG features for
MCP-only clients. Pi supplies a reference behavior where covered. Trace/usage
joins are a separate observability task and do not pass the NMG parity gate.
