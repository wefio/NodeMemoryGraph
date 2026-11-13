# Declaration-driven adapter capability assembly

[中文](adapter-capability-assembly.zh-CN.md) · [Terms](adapter-capability-assembly.terms.yaml)

**Status:** current
**Authority:** [Harness integration](harness-integration.md)

## Purpose and scope

This assembly lets a thin adapter acquire shared NMG behavior by providing
executable host bindings and selecting capabilities. It addresses omitted tool
registration, repeated lifecycle wiring and incomplete adapter inventories.
The executable initial slice below runs inside existing plugin entry points.
It adds no scheduler or plugin loader. The broader composition design and names
remain open to adjustment.

## Executable assembly

[`adapter-capability-catalog.ts`](../../../src/integration/adapter-capability-catalog.ts)
declares the migrated features of all current entry points. Each consumes
its declaration through
[`assembleAdapterCapabilities`](../../../src/integration/adapter-capability-assembly.ts)
and supplies executable native bindings. This catalog describes assembly coverage;
the [host matrix](../harness-capability-matrix.md) retains overall host coverage.

The shared modules install the memory tool group (`search`, `get`, `remember`),
state and Lab tools, recall preparation, owner-state projection, tool-result
observation, diagnostic attribution, board delivery and passive completion nudges.
Each entry selects only its implemented bindings. Kimi currently assembles its
shared nudge; its older board poller is still native code. MCP assembles explicit tools. The Codex package binds the shared tool server per
native request and assembles its context, state, observation and prompt-time board
hooks. Its [package guide](../../../codex-plugin/README.md) owns installation and
session-generation behavior. Magpie remains a separate target.

The assembler validates every required binding before registration. Missing
tools, missing lifecycle bindings and duplicate capabilities fail setup. Disabled
modules are explicit and execute no binding. Existing native schemas and tool
order are retained within a group. Installers can return native cleanup callbacks
or promises; asynchronous hosts await `ready`. Failure releases accepted
registrations, including callbacks accepted after disposal. `dispose()` releases
registrations once, and `describe()` reports pending, assembled, disabled, failed
or disposed states. These are assembly states, not live-hook or enabled-state
certificates. Endpoint methods, session ownership and writer fences are still
checked by the existing operation paths.

Native admission, cancellation, deadlines, generation fences, committed-answer
boundaries and enqueue receipts remain in their adapters. Pi/OpenCode/DSH call
the same assembled observation implementation after normalizing native events.
DSH retains its per-session queue and endpoint liveness checks. Preparation does
not write a delivery receipt or authorize a memory claim.

The entry-point contract test discovers conventional public plugin entries,
resolves the Pi manifest wrapper and checks DSH/MCP entries against the catalog.
It also verifies that each descriptor is consumed by its entry point. Controlled
host and MCP regression tests exercise actual tools and context behavior. This
change does not upgrade a running host. The retained
[native recheck](../../experiments/runtime/native-plugin-capabilities-2026-11-12.md#capability-assembly-recheck-2026-11-13)
exercises installed DSH services and a private OpenCode HTTP host with a loopback
model, including deferred tool transformation and compaction recovery. It does
not cover full DSH Agent execution, production providers or live idle wake.

The shared layer already has tool/action contracts, Agent Surface rendering,
`SessionRecallFlow`, `RecallBudget`, context preparation and endpoint/session
binding. Hosts still register and orchestrate parts separately. In particular,
`HarnessConnection` negotiates service methods/capabilities; it does not assemble
host events or grant a host an injection interface.

## Three responsibilities

| Owner | Declaration and executable responsibility |
| --- | --- |
| Shared NMG capability | One implementation, its required ports, service operations, lifecycle semantics, output/budget rules and contract checks |
| Thin host adapter | Versioned bindings to native tool registration, admitted turns, context delivery, final tool results, completion and wake interfaces that it actually implements |
| Bound session | Resolve available capabilities from the bindings and endpoint, then apply configured enablement and select one effect owner per operation |

For example, adding a shared feature should make it available to every adapter
whose existing bindings satisfy its requirements. Those adapters should not need
another copy of the feature's orchestration. Host-specific missing ports still
need implementation; a boolean declaration cannot create a native hook.

Declaration or configuration changes can activate installed implementations.
New shared runtime code still requires loading a compatible version. Updating
daemon declarations alone does not update a bundled DSH plugin or an already
running OpenCode plugin.

| Example feature | Required binding shape | Remaining semantic distinction |
| --- | --- | --- |
| Explicit memory/state tools | Tool registration, authenticated endpoint and session binding | Tool availability does not provide automatic context carriage |
| Automatic recall | Appropriate admission signal, context insertion and bound scope | A gateway request is not necessarily a new user turn |
| Maintained-state carriage | Owner-state access and an admitted complete-body context path | Preparation and final delivery remain distinct |
| Tool observations and answer attribution | Bound final-result/committed-answer events | A pre-execution reminder is not a final tool result or claim witness |
| Board delivery | Local board access and supported host enqueue | Next-prompt delivery and idle wake are separate capabilities |

An illustrative binding can name `tools.register`, `turn.admit`,
`context.prepare`, `tool.result` and `execution.end`. NMG attaches the existing
shared flows to those ports and publishes the resolved tool/capability surface.
These names are examples, not a proposed API that adapters may call today.
Start with a small binding object and ordinary functions, rather than a general
workflow engine or another scheduler.

## Resolve behavior rather than trust a label

A capability description can distinguish declared support, completed assembly,
session enablement and validation evidence. Missing bindings, incompatible
versions, an unavailable endpoint or a host-disabled hook explain why a feature
is unavailable. A declared or assembled feature is not automatically a tested
or enabled feature.

Check the service's advertised methods and the host's actual installed bindings
together. Re-evaluate at a new session generation or reconnect. The descriptor
does not grant authentication, writer authority or hook trust. In particular,
Codex plugin support and a verified NMG Codex hook package are separate facts;
missing NMG delivery is not a host restriction.

Keep the existing union of providers. Native plugins, MCP, event hooks, CLI and
Magpie can contribute ports where a trusted mapping joins the same authorized
session/scope. Selecting a provider does not remove another plugin's complete
implementation. Failure to establish the mapping leaves a documented gap instead
of silently sharing AG IDs, repeating effects or converting request-time notices
into purported idle wake.

## Inventory, usage guidance and checks

The catalog supplies declarations and machine-readable assembly diagnostics.
Automatic generation of the overall capability matrix remains a target.
Generated capability summaries should link to maintained host setup instructions and
scoped validation evidence. Installation commands and host-specific caveats
remain at their current owners rather than being inferred from capability names.

Useful checks include missing required ports, incompatible service methods,
declared tools absent from the host catalog, no event activation, canceled/late
preparation, incorrect session generation and duplicate ownership across providers.
Real host activation remains a separate proof from descriptor/type validation.
An unregistered adapter must surface as an inventory error, not disappear from a
matrix because an author forgot a column.

The remaining work is cross-provider session composition, per-operation effect
ownership, automatic matrix generation and migration of legacy local policies
such as Kimi's board poller. Those are not implied by local assembly. Keep current
adapters usable and require scoped equivalence evidence before migrating further
behavior. The current
[usage guide](../../../skills/nmg-memory/references/adapter-usage.md) documents
the actual connections.
