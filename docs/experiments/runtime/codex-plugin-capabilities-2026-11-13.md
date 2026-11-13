# Native Codex plugin capability exercise

[中文](codex-plugin-capabilities-2026-11-13.zh-CN.md) · [Terms](codex-plugin-capabilities-2026-11-13.terms.yaml)

## Distributable adapter

The self-contained Codex package installs from an extracted archive into the
native plugin cache. Windows CLI 0.169.0 completed 20 deterministic model requests
across two concurrent chats, a resumed chat and a real native fork. Native hook
admission and MCP metadata join the same private daemon and project scope.
Automatic recall, all five tools and full maintained-state carriage execute.
The explicitly selected Skill comes from the installed plugin cache.
[Artifact receipt](artifacts/codex-plugin-capabilities-2026-11-13/distribution.json)

The fork inherits its native transcript. Isolation checks read the fork's current
owner AG and verify that parent state remains in the parent AG. Contract tests
also reject a foreign projection on a shared MCP connection and fence old turns
after clear. The client archive contains no source-checkout or node_modules runtime
dependency. Desktop GUI, other operating systems and native interactive compaction
are unexercised by this distribution probe. Compaction carriage has contract tests.

```text
npm run codex:package -- --output <release-directory>
node docs/experiments/runtime/codex-distribution-probe.mjs --codex-bin <codex.exe> --archive <release-directory>/nmg-codex-plugin-0.1.0.tgz --output <evidence-directory>
```

The probe verifies that explicit state writes and memory saves reach its private
RPC owner. Child environment forwarding and recovery from an earlier misrouted
fixture run are recorded in the incident owner.
[Child environment incident](../../postmortem/0008-codex-private-home-shared-daemon.md)
[Package use](../../../codex-plugin/README.md)

## Result and scope

NMG works through Codex's native local-plugin installation path. The installed
plugin supplies the existing NMG MCP server and Skill, plus a source-bound hook
fixture using shared capability assembly. Deterministic Responses traffic stays
on a loopback listener; memory lives in a private NMG owner. No production
configuration, shared host or external model/embedding credentials are used.

| Surface | Observed result |
| --- | --- |
| Plugin installation | Local marketplace add/install/list succeeds; the installed cache is used |
| Skill | The packaged NMG Skill reaches a model request when explicitly invoked |
| Explicit tools | All five tools enter the native tool catalog; search, exact get, remember, state enable/replace and Lab list execute through MCP |
| Automatic context | `UserPromptSubmit` calls the assembled recall/state projections and its context reaches the loopback model |
| Continuity | Resume the same Codex thread; the next user turn receives the complete maintained-state marker and invariant |
| Native events | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop execute; the fixture records 18 events over two turns |

The tested binaries are the desktop application's bundled engine
`0.167.0-alpha.4.1` and standalone CLI `0.167.2`. Execution uses their CLI and
app-server interfaces, not desktop GUI interaction. Receipts retain binary/source
hashes, model-request marker summaries and native event metadata, not full prompts
or credentials. Reported response usage is synthetic fixture data.

## Conditions found during the exercise

The [official packaging guide](https://developers.openai.com/plugins/build/plugins)
prefers root `plugin.json` and documents the `.codex-plugin/plugin.json`
compatibility path. In the tested binaries, portable/root and root-plus-overlay
fixtures loaded MCP/Skill but returned no plugin hooks from `hooks/list`.
The compatibility-only layout discovered the hooks with `source=plugin`.
This is a version-scoped observation, not a general claim that portable hooks
are unsupported. Keep the `--layout portable|overlay` cases as negative probes;
they must not report full success when hook/context checks fail.

Other conditions:

- Hooks are disabled by default in these binaries. The private config enables
  `features.hooks`. Hook discovery alone does not establish execution.
- The experiment explicitly bypasses persisted hook trust for its own reviewed,
  generated fixture commands. It does not change user hook trust. Ordinary
  installation still follows the [hook review flow](https://learn.chatgpt.com/docs/hooks).
- Bundled MCP tools initially require approval. The private probe grants its
  own server approval so automated calls can run with a never-ask policy.
  A listed tool whose call is refused is not counted as executed.
- Portable MCP commands accept `node` as a bare executable name. An absolute
  executable path was rejected by the portable loader.
- On this Windows host, `node "${PLUGIN_ROOT}/hooks/run.mjs"` executes.
  Starting the command with a quoted absolute executable path failed to run
  the fixture. The interpreter lookup therefore remains part of host setup.
- Responses namespace calls carry separate `namespace` and `name` fields.
  Joining them with a dot produced unsupported calls in the native router.

## Evidence and remaining work

The fixture binds one private Codex conversation to a fixed operator-selected
NMG session used by its MCP connection. The hook's native session/turn IDs are
recorded; they are not treated as model-authored authorization. This controlled
mapping does not implement production session discovery, multiple concurrent
chats, forks or reset/reconnect generations.

The hook uses `assembleAdapterCapabilities`, InformationView output and the
current owner state. Preparation writes no delivery/disclosure receipt. The
loopback receiver is an experimental witness. Pre/post-tool events are recorded
to verify the host boundary; this is not a shipped general tool-capture or
answer-attribution binding. Compaction, idle wake, subagents, event cancellation
and desktop installation UX remain untested here.

There is still no released standalone NMG Codex adapter. The successful
source-bound plugin fixture shows that missing NMG wiring is not a host
restriction. It supports pursuing native Codex parity independently of Magpie.

## Reproduction

Use a persistent prepared NMG checkout and an explicitly selected binary:

```text
node docs/experiments/runtime/codex-plugin-probe.mjs --codex-bin <codex.exe> --layout compatibility --output <evidence-directory>
```

The [probe](codex-plugin-probe.mjs) creates a private Codex home, local marketplace,
installed plugin copy, model listener and memory owner. It ends child stdin,
limits command/request lifetimes, checks actual memory RPCs and received context,
and closes its resources. The [hook fixture](codex-probe-hook.mjs) is source-bound
to this checkout; its generated package is not a distributable production plugin.

Retained evidence: [desktop engine](artifacts/codex-plugin-capabilities-2026-11-13/desktop.json),
[standalone CLI](artifacts/codex-plugin-capabilities-2026-11-13/cli.json),
[portable negative controls](artifacts/codex-plugin-capabilities-2026-11-13/portable-control.json).
