# Private Codex home with a shared NMG daemon

[中文](0008-codex-private-home-shared-daemon.zh-CN.md) · [Terms](0008-codex-private-home-shared-daemon.terms.yaml)

**Status:** resolved

## Executive summary

A built-plugin probe set a private NMG directory in its parent environment.
Codex filtered that variable from MCP children. Hooks reached the private owner,
while explicit tools fell back to the default owner. Identity checks passed and
state carriage failed. The fix forwards the directory explicitly and verifies
that each writing path reaches the private daemon.

## Summary

Concurrent test chats used correct native IDs on different daemon instances.
The shared owner received two synthetic memories and temporary AG/presence data.
The private owner's request log contained hooks but no explicit tool writes.

## Impact

The exact synthetic memory IDs and contents were checked, then withdrawn through
resolveRemember. Nine test AGs were released. The older shared daemon lacks the
withdraw-presence operation, so its temporary registrations use heartbeat expiry.
The probe used deterministic loopback responses. Existing user records were kept.

## Timeline

Artifact installation and explicit tools succeeded. Resume lacked the owner
state written through MCP. Reading both the private RPC log and native outputs
exposed separate owners. The corrected package passed concurrent chat, resume,
fork, automatic recall and explicit-write checks against one private daemon.

## Root cause

CODEX_HOME isolates host state. MCP child environment inheritance is independently
controlled. NMG_DATA_DIR was assumed to cross that boundary. Earlier checks
confirmed identities and output text without confirming the receiving daemon.

## Guardrails added

- The [package manifest](../../codex-plugin/.mcp.json) forwards NMG_DATA_DIR.
- The [distribution contract test](../../tests/scripts/build-codex-plugin.test.ts)
  checks the forwarded names and packaged startup.
- The [native probe](../experiments/runtime/codex-distribution-probe.mjs) requires
  explicit state writes and synthetic memory saves in its private RPC log.

## Lessons

Validate the receiver of each component's side effects when testing a host that
starts multiple child runtimes. Session identity alone cannot identify the store.
