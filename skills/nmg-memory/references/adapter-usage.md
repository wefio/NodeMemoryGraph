# Use NMG through an adapter or CLI

[中文](adapter-usage.zh-CN.md) · [Terms](adapter-usage.terms.yaml)

Use this guide to choose, install and operate any shipped NMG host connection.
For implementation work, read [the adapter contract](harness-adapters.md).
The [capability matrix](../../../docs/design/harness-capability-matrix.md) owns
source coverage; each host's README owns detailed installation settings.

## Choose a connection

Installing the Skill provides instructions. Tools, automatic recall and state
carriage depend on the adapter connected to the current conversation.

| Environment | Install or configure | How to use it and what remains manual |
| --- | --- | --- |
| [Pi](#pi) | Install the root Pi package | Native memory/state tools, automatic recall, state carriage and board wake |
| [Claude Code and other MCP clients](#claude-code-and-other-mcp-clients) | Register the stdio MCP server | Explicit memory/state/board tools; no automatic recall, state carriage or idle wake from MCP alone |
| [Codex](#codex) | Install the generated Codex plugin | Native session-bound tools, automatic recall, state carriage and prompt-time board delivery |
| [WorkBuddy](#workbuddy) | MCP tools plus optional event hook and Skill | Hook adds automatic recall and prompt-time board polling; hook and MCP have different AG sessions |
| [Kimi Code CLI](#kimi-code-cli) | MCP tools plus optional Kimi hook and Skill | Hook adds reminders, presence and prompt-time board polling; it does not search memory or carry maintained state |
| [DeepSeek Harness](#deepseek-harness) | Build and install `dsh/dsh-nmg/` into the selected profile | Native tools, automatic recall, state carriage and session-directed coordination |
| [OpenCode v2](#opencode-v2) | Load `opencode-plugin/` in a fresh service | Native tools, automatic recall and state carriage; some lifecycle boundaries remain unverified |
| [Other shell-capable Agents](#cli-and-skill) | Skill plus the NMG CLI | Explicit memory/state/board operations; installing a Skill does not add host hooks |

Use a persistent checkout and compatible plugin/daemon versions. On a fresh
checkout, run `npm ci` and `npm run build` from its root before host setup. Merge
client configuration with existing entries; do not replace unrelated settings.
Reuse connected tools instead of repeating the same operation through MCP and
CLI. A hook can complement a tool server without sharing its session identity.

During setup or failure diagnosis, inspect `nmg daemon status --json` and follow
[daemon operations](operations.md). Pi and MCP manage only their own daemon
lifecycle; OpenCode and the WorkBuddy/Kimi hooks do not start a daemon. DSH may
ensure one is available but does not expose lifecycle ownership. Reuse a running
compatible shared owner. Coordinate upgrades of an incompatible live owner at a
safe point; do not delete lease files or stop shared services to test a plugin.
Individual features may also require advertised capabilities.

## Daily use

Use the operations actually exposed by the selected connection. Native and MCP
tools supply their session/writer binding outside model-authored arguments. With
CLI, select your own conversation's `--session-id` explicitly and keep it stable;
never borrow another Agent's session to bypass an ownership error.

| Need | Operation |
| --- | --- |
| Recall a decision | Use relevant current recall headers, or call `nmg_search` / CLI `search` with a focused query. Headers remain candidates. |
| Inspect evidence | Use selected IDs with `nmg_get` / CLI `get` and the corresponding `activeGraphId` where available. Keep the connection and session consistent. |
| Save or update durable memory | Use `nmg_remember` / CLI `remember`; follow [writes](writes.md) for supported actions, source evidence and forgetting. |
| Maintain progress | Where state tools are connected, enable the AG writer and replace the complete current text through `nmg_state`. CLI also provides resident-owner state operations. |
| Coordinate Agents | Use `nmg_state space=board` or CLI board operations. Follow [board usage](board.md) for discovery, subscriptions, batch reads and replies. A hook notice is a prompt to inspect work, not an automatic claim. |

For example, call `nmg_state` with these argument objects in order:

```json
{"space":"ag","action":"write","operation":"enable","reason":"Continue the current task"}
```

```json
{"space":"ag","action":"write","operation":"replace","text":"Goal: finish the adapter.\nVerified: tools run.\nNext: validate the remaining boundary."}
```

`updated` and `unchanged` are normal short receipts. On Pi, DSH and OpenCode,
the next admitted user turn can carry complete current state independently of
optional recall. MCP/CLI explicit state access does not itself provide this
automatic carriage; adding a WorkBuddy or Kimi hook does not add it either. Read
current state explicitly when the chosen connection lacks a carriage path.
A write receipt or model repetition does not confirm final provider input.

Update state only when it changes. Use `operation=clear` to discard it and
`operation=disable` to end the writer lease while retaining readable text.
[Daily work status](optional-capabilities.md#daily-work-status) covers lease
expiry, content limits and recovery. Do not use Lab or a fabricated binding to
bypass a missing lease. Temporary progress is not durable memory.

Tool observations and diagnostic answer attribution exist only where wired.
A reminder, pre-execution hook, successful tool or completed reply does not
certify a remembered claim. Submit feedback only when the connected operation
supports the required labels and you can judge them; do not invent a positive
outcome to compensate for missing feedback support.

## Pi

From the prepared checkout root, install the package and start Pi:

```text
pi install ./
pi
```

The root manifest selects `extensions/nmg.ts`, which loads the shared Pi
extension. It exposes memory tools, `nmg_state` and optional `nmg_lab`. Use `/nmg`
for the host console; `/nmg state` reads the complete admitted state, and its
on/off control changes only the preview. Wake controls are also in `/nmg`.
Setup details are in the [Pi instructions](../../../README.md#pi).

Automatic recall and maintained state use the persisted per-user-turn
`nmg-context` path. A later inference in that turn does not trigger another state
insertion. Native tool results feed observations and weak commit reminders;
Agent-end attribution is diagnostic. Automatic write policy does not imply that
every message is saved. The extension reuses a compatible shared daemon and
stops only one it started itself.

## Claude Code and other MCP clients

The repository's stdio server is
`claude-plugins/nmg-memory/agents/memory-copilot.ts`. Claude Code, Claude Desktop,
Cursor and other MCP clients can use the same server transport; each
client owns its configuration format. For a Claude-compatible JSON configuration:

```json
{
  "mcpServers": {
    "nmg": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "C:/path/to/NodeMemoryGraph/claude-plugins/nmg-memory/agents/memory-copilot.ts"]
    }
  }
}
```

Claude Code uses project `.mcp.json`; for other clients translate these stdio
fields to that client's supported configuration. Use an absolute script path,
reload the client connection at a safe boundary, and inspect the actual tool
list. The [MCP setup owner](../../../claude-plugins/nmg-memory/CLAUDE.md#adding-to-any-mcp-client)
has client examples. Do not assume that a Claude plugin manifest alone registers
the server in every client.

The server exposes `nmg_search`, `nmg_get`, `nmg_remember`, `nmg_state` and
`nmg_lab`. Ordinary AG/board work uses `nmg_state`, not a separate board or Lab
tool. The server ensures a daemon on connect, reuses a compatible existing one
and stops only its own process on exit. Session identity belongs to that server
connection. Do not assign one fixed session ID to unrelated concurrent clients.

MCP alone supplies explicit operations, not per-turn recall, automatic state
carriage, general host-tool observation, answer-end attribution or idle wake.
Some remember actions also have adapter implementation gaps; the matrix records
them. Re-read/search through this MCP session before using IDs from a separate
hook connection. Matching Agent names does not join AG projections.

## Codex

Build and install the generated self-contained Codex plugin. Its README owns
packaging, Node requirements, hook trust and loading instructions.
[Codex setup](../../../codex-plugin/README.md)

The adapter supplies five tools, automatic recall, complete working-state carriage,
final-tool observations and prompt-time board batches through shared capability
assembly. Native MCP metadata and hook admission bind tools to the same chat and
project. Resume retains the binding. Forks have independent AG state. Native clear
starts a fresh generation and requires a newly admitted turn.

Use the same search/get and state enable/replace operations described above.
Hooks require explicit enablement and trust. Tools work when hooks are disabled,
with project scope unavailable until admission. Answer attribution and idle wake
remain unavailable in this binding. A compatible daemon must already be running.

## WorkBuddy

Connect the MCP server above for tools, and install this Skill for instructions.
The optional event hook is `workbuddy-plugin/nmg-hook.ts`. Merge its
`UserPromptSubmit` and `PreToolUse` entries from the
[WorkBuddy registration example](../../../workbuddy-plugin/README.md#registration)
into `~/.workbuddy/settings.json`, using an absolute checkout path. Preserve
existing hooks. Apply changes through WorkBuddy's supported loading procedure.

The hook adds budgeted automatic recall, identity registration, prompt-time board
polling and a pre-commit reminder. It requires an already-running compatible
local daemon and does not start one. It does not provide memory tools, a state
writer, automatic state carriage, general tool-result observation or answer-end
attribution. MCP supplies explicit tools and state access when connected.

The hook uses `workbuddy-hook:<sessionId>` while MCP has its own session. Never
pass a hook-created `activeGraphId` to MCP `nmg_get`: search again through MCP,
then read selected evidence in that same tool session. Board notices arrive on
hook invocation, not as an unsolicited wake while the Agent is idle. The
[WorkBuddy guide](../../../workbuddy-plugin/README.md) owns hook settings and limits.

## Kimi Code CLI

Connect MCP for memory/state tools and the Skill for instructions. Kimi's optional
hook is `kimi-plugin/nmg-hook.mjs`. Merge the two `[[hooks]]` blocks from
[`config.example.toml`](../../../kimi-plugin/config.example.toml) into
`~/.kimi-code/config.toml`, replace paths with your checkout's absolute path, and
start a new session. On Windows preserve the template's quoted command path.
The supported hook fields are `event`, `matcher`, `command` and `timeout`.

`UserPromptSubmit` provides completion-keyword reminders, presence and board
polling; `PreToolUse` with a Bash matcher provides a git-commit reminder. The
hook does not perform automatic memory recall, maintained-state carriage or
post-tool observations. A pre-commit reminder does not prove that a commit
succeeded. Hook-only installation therefore cannot supply memory/state tools.

The hook is passive when no daemon is available. Board notices appear on the
next user prompt, rather than through a background idle wake. Subscribe/read
through the connected board tools; do not equate hook/MCP display names with a
shared session. Use the [Kimi guide](../../../kimi-plugin/README.md) for its
notification controls and hook-only verification examples.

## DeepSeek Harness

Use the dual-face host package `dsh/dsh-nmg/`. From that directory:

```text
pnpm install --frozen-lockfile
pnpm run build
```

For initial web-profile installation:

```text
dsh plugin --profile web add "link:<checkout>/dsh/dsh-nmg"
```

Load the build at a coordinated restart or supported safe loading boundary.
`lib/index.js` and `lib/client.js` must exist; building does not update an already
running host. The [package README](../../../dsh/dsh-nmg/README.md) owns profile
settings. The historical `dsh/nmg-plugin.mjs` preset is not another current target.

Native tools include memory, state, optional Lab and health access. Recall starts
at inbox arrival; request admission prepares complete state and awaits bounded
recall before the native loop refreshes `systemPrompt.context`. A new inbox
generation excludes the previous automatic fragment. Final tool results feed AG
observations and weak commit reminders. Committed answers are attributed only
at completed `turn/end`, with cancellation and duplicate suppression. Discovery
represents actual Agent sessions, not an empty adapter host.

## OpenCode v2

Load `opencode-plugin/` from the persistent checkout. It exports `index.ts`
directly and has no separate adapter build step. In `opencode.json`:

```json
{"plugins":["C:/path/to/NodeMemoryGraph/opencode-plugin"]}
```

A directory link under `.opencode/plugins/` is another installation path; choose
one registration. Use a fresh service at a safe session boundary: the module
cache means checkout edits do not update an existing process. OpenCode's NMG
plugin does not start or stop the daemon. See the
[adapter README](../../../opencode-plugin/README.md).

Code Mode uses explicit `nmg_` names, for example
`await tools.nmg_search({query: "Which database did Atlas choose?"})`. Native
session lookup supplies first-turn scope, with plugin location as fallback and
`NMG_PROJECT_DIR` as override. If neither yields a directory, recall lacks
project scope. Prompt preparation has a 1.5-second total budget; late results
cannot change current scope. Native prompt/context hooks stage complete state
and recall, retaining a prepared fragment for rebuilt requests. New prompts,
compaction and execution completion invalidate stale preparation as appropriate.
Manual compaction followed by new-turn state carriage has controlled runtime
evidence; other lifecycle sequences retain their own validation gates.

## CLI and Skill

Use CLI when the host has shell access but no connected NMG tool server. An
installed package provides `nmg`; from a checkout use `node bin/nmg.mjs`:

```text
node bin/nmg.mjs daemon status --json
node bin/nmg.mjs search "Which database did Atlas choose?" --project-dir . --session-id <SESSION> --limit 8 --compact-json
node bin/nmg.mjs get <MEMORY_ID> --active-graph-id <GRAPH_FROM_SEARCH> --project-dir . --session-id <SESSION> --json
node bin/nmg.mjs remember "Atlas uses SQLite." --node Atlas --project-dir . --session-id <SESSION> --json
```

Keep the selected data store, project and conversation ID consistent. Use the
resident-owner `nmg state`/board commands for explicit state and coordination;
[operations](operations.md) and [daily state](optional-capabilities.md#daily-work-status)
own exact lifecycle forms. CLI plus Skill does not install an automatic recall,
state-carriage or background-wake hook. Do not use another server's session ID
merely to reuse its `activeGraphId`.

## Check activation and diagnose failures

Use harmless, disposable data and a private session for checks. A focused search
followed by selected exact get verifies the connected tool path. Empty results
are valid and do not prove load failure. For a host with automatic state
carriage, write a complete state and send the next prompt; explicit read access
alone does not establish carriage or final provider delivery.

| Symptom | Next action |
| --- | --- |
| Skill is available but tools are missing | Check the selected plugin/MCP registration, process logs and actual tool catalog. Installing instructions alone does not connect tools. |
| Pi console or native tools are missing | Check the installed root package and extension loading. Read-only `/nmg state` visibility controls do not enable the writer. |
| MCP tools fail to connect | Check Node version, dependencies, absolute script path and client stdio configuration; inspect daemon compatibility without deleting its lease. |
| WorkBuddy/Kimi is silent | Check event registration and the already-running local daemon. Silence is fail-open behavior, not proof of successful recall or an idle-wake implementation. |
| DSH cannot load `lib/index.js` | Build the source package and coordinate loading that build. Do not edit generated deployment files. |
| OpenCode shows old names or behavior | Check that a fresh service loads the intended checkout once. `options.namespace` does not prefix names in the verified SDK. |
| State returns `updated` but is absent later | First check whether that connection supports automatic carriage. Then check session, lease and next-turn boundary; read current AG state explicitly. |
| A graph belongs to another session | Search through the tool connection that will perform get. Do not borrow identities or assume hook/MCP handoff. |

Each installation has its own verification scope. The retained
[DSH/OpenCode probe](../../../docs/experiments/runtime/native-plugin-capabilities-2026-11-12.md#reproduction)
uses private stores and a loopback model; it does not validate every adapter.
Pi, hook and MCP checks belong to their respective sources and test suites.
API-only queries without activation cannot establish plugin support. Live idle
wake, fork/reset/reconnect and desktop loading need host-specific evidence.

## Combine with Magpie

Magpie remains a complete independent NMG plugin target in the
[integration design](../../../docs/design/unified-architecture/magpie-integration.md).
This guide does not invent an installation command for that undelivered binding.
For validated combinations, select one effect owner per operation and share
an authorized session/disclosure context. Preserve each plugin's full capability
surface while avoiding duplicate effects. Matching names do not join sessions;
GUI, usage and tracing are separate enhancements. The proposed pi durable cloud
binding is also a design target, not an installed local adapter.
