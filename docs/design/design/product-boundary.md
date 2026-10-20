# Product boundary: NMG Lite

[简体中文](product-boundary.zh-CN.md) · [Terms used](product-boundary.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Product boundary: NMG Lite

The target default plugin should install as a normal Pi package and require only
Node.js, Pi, and SQLite. FTS search must work without an embedding server. A
semantic embedding provider may be enabled by configuration, but local Qwen,
vLLM, CUDA, USearch, general-purpose ML frameworks, and Cloudflare are not
default dependencies.

The default model-facing surface is three durable-memory tools, one state entry
and one Lab capability entry point:

```text
nmg_search(query, filters, budget)
  -> compact result headers, IDs, dates, types, sources, and retrieval costs

nmg_get(ids)
  -> exact selected memories and bounded raw evidence

nmg_remember(statement, type?, scope?)
  -> explicit/hot-path durable write through the same governed write policy

nmg_state(action, space, operation?, ...)
  -> read/write private AG or shared board state through its existing owner

nmg_lab(action, capability?, ...)
  -> discover and explicitly lease optional experimental session capabilities
```

These signatures are abbreviated. `nmg_remember` also accepts explicit
`forget` and `feedback` actions; its optional `recallTriggers` field accepts at
most 16 short phrases. See [session capture and write path](session-capture-and-write-path.md)
for the governed write details.

Cross-Agent coordination is an independent capability, but its discovery surface
is enabled by default: adapters expose board operations through `nmg_state` and wake polling unless
`NMG_ENABLE_COORDINATION` is explicitly set to `0`, `false`, `off`, or `no`.
This lets a newly attached Agent discover and join shared work without every peer
first performing a manual enable step. Daemon RPC and CLI board operations remain
available when the model-facing surface is disabled.

Automatic extraction may use the same write path. Physical privacy erasure,
reindexing, graph editing, feedback inspection, and maintenance belong in
CLI/UI/background operations rather than ordinary model tools. The explicit
`nmg_remember action=forget` is limited to logical withdrawal and does not claim
physical erasure. The separate exception is an explicit, session-owned
calibration label submitted through `nmg_remember action=feedback`; it records
adapter-owned evaluation metadata and never mutates memory truth or ranking.
This feedback action is currently a Pi shadow-controller integration, not an
NMG Core/RPC method.

The default Pi package exposes only this surface. Graph editing,
rebalancing, consolidation, QPP, and experimental reasoning remain background,
CLI, benchmark, or administrative concerns. Explicit retrieval feedback is an
action on the existing remember boundary, not another tool or an automatic
inference from user silence.

### Agent-independent CLI and resident service

Read the complete responsibility: [Agent-independent CLI and resident service](product-boundary/agent-cli-and-resident-service.md).

### Modular harness adapters

The TypeScript prototype is split by responsibility at the HTTP
client/server process boundary:

```text
Agent-specific adapter
  |- native message -> AgentHistorySnapshot
  |- native lifecycle -> recall/write/feedback calls
  |- native tool schema and host-only actions
  `- prompt/context injection
                |
                v
Agent-independent integration modules
  |- config: environment and feature-mode parsing
  |- evidence: selective source-message retention
  |- search: lexical/hybrid retrieval with explicit degradation
  `- Agent Surface: shared DTO projection, budgets, redaction and default rendering
                |
                v
NMG core + SQLite
```

An adapter must provide stable session and message IDs, normalized actors and
text, an optional source reference, and lifecycle hooks for pre-turn recall,
post-turn feedback, and shutdown. It must not parse SQLite rows, update graph
topology, implement QPP, or construct embedding indexes. Pi is the first
adapter, not part of the NMG data model. The [first-response timing decision](../../decisions/implemented/2026-10-04-first-response-timing-is-opt-in.md)
records opt-in metadata-only observation and slow-input-to-recall retention. The
historical [session-hook index](../session-memory-lifecycle-hooks-2026-08-10.md#current-owner-map)
points to current owners; consult the current extension for event-level wiring.
Observation does not change recall waiting policy or issue provider probes.

Agent-facing result semantics have one integration-layer owner. The shared
`Agent Surface` projects and renders compact search headers, exact evidence,
bounded remember follow-up candidates, Task Board entries, and logical-chain
structure. It owns stable field names, withdrawal redaction, evidence/structure
budgets, chain labels, and default next-step placement. An adapter may wrap that
text in a native content block or add a host lifecycle notice; it must not
recreate the candidate DTO, evidence layout, board conventions, or semantic
follow-up rules. Storage tiers, ranking scores, QPP internals, timings, and token
estimates remain in Core traces or diagnostic output and never enter the
Agent-facing candidate DTO. Structured daemon results remain canonical and the
Agent Surface is a replaceable presentation boundary, never another store or
protocol version. Degraded search keeps its mode and bounded cause code in
both candidate and empty-result output. Known embedding HTTP failures expose
`embedding_http_<status>`; admitted embedding/index codes remain unchanged;
unrecognized diagnostics expose `unknown`. Provider response bodies stay in
the original structured result and daemon diagnostics, not in compact candidate
DTOs or their rendering.

Shared service search derives `ref:<hex-prefix>|<quote>` selectors for eligible
visible text headers. Prefixes grow from four hex digits by two until the
combination is unique in the original readable candidate set; quotes use the
first six whitespace-normalized Unicode code points, without case folding or
NFKC. Get accepts whole selectors with their original `activeGraphId` and read
scope. Original ID/quote witnesses live inside the existing immutable private AG
projection. Resolution first identifies the original canonical ID, then checks
that ID against current readable content; a quote moving to another record cannot
rebind the selector. Missing/foreign/expired projections, malformed selectors,
zero matches and ambiguity fail closed without latest-graph inference or retries.
Durable traces alone have no content witness and do not resolve compound RPC
selectors. The shared library helpers accept an original captured scope and a
current-content guard; Core exact lookup remains canonical-ID based.

Full IDs remain usable without a graph and identify records in exact output,
compact JSON, lifecycle actions and attribution. Derived text-reference maps are
presentation data, not a separate store. Withdrawal, unusable quotes and long
collisions retain full IDs. Deferred/folded ID-only rows retain UUIDs rather than
disclosing a new quote. These selectors are temporary locators, not durable IDs,
authentication or immutable whole-record version hashes.

The existing status RPC exposes `getReferenceUsage` (`fullIds`, `compoundRefs`),
visible through `nmg status --json`. Each validated get input array entry counts
once before resolution: non-`ref:` IDs (including legacy IDs) and `ref:` attempts
are separate. Duplicates, missing IDs and rejected selectors count; invalid RPC
parameters and internal reads do not. Counters start at zero per service instance,
reset on restart, and status returns a copy without opening storage. They measure
input usage, not successful reads or reference quality.

Shared search/get disclosure copy lives in `src/prompts/nmg-prompts.yaml` and
reaches runtime consumers through generation. Named candidate/evidence fields
carry the record data; surrounding copy explains preview versus evidence,
semantic node/temporal/chain labels, external and unresolved markers, and the
non-guarantee of ranking. Counts and conditional exact-read/withdrawal guidance
close the body without repeating its field template. Wrapper changes do not
shorten previews or saved statements, change structured results or candidate
selection, replace historical injections, or remove feedback/completion duties.
Bare renderers and caller-supplied wrapping remain available. A feedback
affordance names its full graph ID once at the actionable call; its accompanying
search header independently retains the graph ID for exact-read attribution.
Standalone and empty-result feedback remain attributable without an earlier header.

The package dependency boundary follows that architecture. NMG Core, the daemon,
and non-interactive CLI paths do not import Pi. The Pi adapter type-checks against
`@earendil-works/pi-coding-agent` as a development dependency and declares it as
an optional peer supplied by the harness; installing NMG for CLI-only use must not
pull the Pi harness into the runtime graph. `@earendil-works/pi-tui` remains a
runtime dependency only because both the adapter UI and the standalone lazy-loaded
`nmg inspect` command execute it. Its version line must stay aligned with the Pi
harness to avoid duplicate or incompatible TUI component instances. If install
cost later becomes material, the adapter or inspect TUI may become a separate
package, but Core does not need a package split to preserve this boundary.

The Pi adapter is now a thin HTTP lifecycle/tool adapter. It lazily starts the
daemon, reuses one connection (via the shared `http-client`) for automatic
recall and the default stable tool surface, and
stops the daemon only when that adapter invocation owns it. It does not open
SQLite, maintain indexes, or import graph/QPP implementations. No Rust/Python
implementation is planned unless profiling later identifies a component that
cannot meet its budget in TypeScript.

Implementation reuse follows semantic ownership rather than textual similarity.
Scope canonicalization and embedding-index lifecycle are single Core rules;
adapters must not reimplement them. Pi, MCP and DSH consume one host-neutral list
of common remember/board actions, while retaining native TypeBox, Zod, or JSON
schema encodings and host-only actions. The same adapters and the benchmark
bridge consume the shared Agent Surface for search/get/remember/board or direct
exact-evidence projection; only host registration, lifecycle, transport fallback,
host-only actions, and official benchmark envelopes or audit fields remain local.
Leaf and node summarizers share the OpenAI-compatible completion client and
bounded drain runner, while retaining
their distinct prompts, pending-task rules, and stale-write semantics.
Host-specific message delivery and process lifecycle hooks remain thin local
adapters because Pi, MCP, Kimi, and DSH expose different event loops. Generated
bundles are not a second implementation, and real-process daemon tests remain
separate from fast in-process fixtures because they verify different boundaries.

Other Agents can use the packaged `nmg-memory` Skill. Its entry document is a
small first-use card; detailed write, recall, and daemon operations live in
linked references and are loaded only when the Agent forgets an operation or
encounters a special case.
