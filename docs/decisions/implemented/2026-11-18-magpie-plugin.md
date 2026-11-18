# Assemble Magpie as a standalone NMG adapter

[中文](2026-11-18-magpie-plugin.zh-CN.md) · [Terms used](2026-11-18-magpie-plugin.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Clients with different host hooks need a common memory surface. Magpie can prepare model context and expose tools to its clients. Its MCP execution context lacks the native session ID needed to route session state.

## Decision

Assemble the adapter from the shared JSON capability manifest. Magpie binds the declared tools, request and completion hooks, and management page. A sealed session handle links eligible gateway requests to plugin tools. Tool-only clients can open a session explicitly. Each gateway agent can defer selected effects to its native adapter.

Use the shared InformationView budget for state, evidence and board notices. Confirm board delivery and automatic-recall attribution using the admitted request context. Keep configuration, index preparation and batched search counts with the daemon. Test a candidate embedding connection and finish preparing the shared index before activation. Project indexes continue to use their existing lazy preparation.

## Alternatives considered

- Use one global MCP session. Concurrent conversations would share state, and exact memory references could cross session boundaries.
- Put storage and embedding configuration inside the gateway process. Other operators would need separate configuration, and plugin reloads would take ownership of durable work.

## Consequences

The plugin can run on its own or alongside a native adapter. Independent native and Magpie sessions keep separate state. Request hooks provide prompt-time board delivery, and response-based attribution remains diagnostic. Search counters cover service attempts, with the current batch vulnerable to abrupt process exit. Gateway tokens come from the Magpie aggregate usage ledger.

The loopback management page allows the specific Windows desktop WebView origin `http://wails.localhost` as a frame ancestor. Browser-hosted Magpie uses its own service proxy. The operator API continues to require its process token.

The [install guide](../../../magpie-plugin/README.md) owns the package and operating steps. The private-host [reproduction script](../../experiments/runtime/magpie-plugin-probe.mjs) exercises an installed bundle, eight MCP tool declarations, two Chat Completions requests, session isolation, owner-state carriage and the protected management snapshot on Magpie 0.1.4338. It uses a loopback model fixture and makes zero paid calls. The [operator test](../../../tests/cli/operator.test.ts) exercises candidate activation using a loopback embedding fixture.
