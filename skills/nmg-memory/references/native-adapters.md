# Use NMG in DSH and OpenCode

[中文](native-adapters.zh-CN.md) · [Terms](native-adapters.terms.yaml)

Use this guide to install, load, use or troubleshoot the repository's native
DSH and OpenCode adapters. For adapter implementation, read
[the development contract](harness-adapters.md). The
[capability matrix](../../../docs/design/harness-capability-matrix.md) separates
source coverage from runtime validation.

## Select the connection

Keep the NMG checkout available and use the plugin and daemon from compatible
versions. For a fresh checkout, run `npm ci` and `npm run build` from its root
before configuring the host. Installing this Skill provides instructions; it does not register tools
or automatic context hooks. Native plugins provide those connections.

When `nmg_search`, `nmg_get`, `nmg_remember` and `nmg_state` are already connected,
use them directly. CLI commands are an alternative for shell access. Do not repeat
the same operation through both paths or add a second MCP installation merely to
duplicate working native tools. Session identities and projection handles from
unrelated tool connections are not interchangeable.

At initial setup or when a call fails, inspect `nmg daemon status --json`. Reuse a
running compatible owner. If stopped, follow [daemon operations](operations.md)
to start one and track ownership. An incompatible live owner needs a coordinated
upgrade at a safe point; a plugin build does not upgrade it. Never stop or replace
a shared daemon as an installation check. Individual features may also require
advertised capabilities, such as DSH's `board-agent-presence`.

## Daily use

Use the host-bound tools without supplying a model-authored session ID, Agent ID
or writer binding. The adapter supplies those values.

| Need | Operation and result |
| --- | --- |
| Recall a decision | Use current relevant recall headers or call `nmg_search` with a focused query. Headers are candidates, not exact evidence. |
| Inspect evidence | Call `nmg_get` with selected memory IDs and the corresponding `activeGraphId` when available, through the same session connection. |
| Save a durable conclusion | Use `nmg_remember` with attributable evidence; follow [writes](writes.md) for updates, forgetting and feedback. |
| Maintain current progress | Enable the AG writer, then replace the complete current text through `nmg_state`. Temporary progress does not become durable memory. |
| Coordinate Agents | Use `nmg_state space=board`; follow [board operations](board.md) for discovery, subscriptions, batch reads and replies. |

For maintained state, call `nmg_state` with these argument objects in order:

```json
{"space":"ag","action":"write","operation":"enable","reason":"Continue the current task"}
```

```json
{"space":"ag","action":"write","operation":"replace","text":"Goal: finish the adapter.\nVerified: native tools run.\nNext: validate the remaining lifecycle boundary."}
```

`updated` and `unchanged` are normal short receipts. The next admitted user turn
prepares the current complete state separately from recall, so empty or failed
optional recall can still carry admitted state. DSH serves it through native
context; OpenCode stages it through prompt/context hooks. A write receipt alone
does not confirm final model input. Do not copy the state into another recall
message or save it as a durable fact to force carriage.

Update only when the state changes. Use `operation=clear` when intentionally
discarding it; use `operation=disable` to end the writer lease while leaving the
text readable. Follow [daily work status](optional-capabilities.md#daily-work-status)
for lease expiry, restart recovery and content limits. A missing lease requires
explicit re-enabling, not a fabricated fence or a Lab workaround.

The adapters observe selected tool results and provide weak commit reminders.
Their answer-overlap attribution is diagnostic. Tool success, reminders and
completed replies do not certify a remembered claim or justify positive feedback.

## DeepSeek Harness

Use the dual-face host package at `dsh/dsh-nmg/`. Its host half registers tools
and context hooks; its browser half renders tool cards. The historical
`dsh/nmg-plugin.mjs` preset is not another current installation target.

1. From `<checkout>/dsh/dsh-nmg`, build the package:

   ```text
   pnpm install --frozen-lockfile
   pnpm run build
   ```

2. For an initial web-profile installation, register the local package:

   ```text
   dsh plugin --profile web add "link:<checkout>/dsh/dsh-nmg"
   ```

3. Load the built package at a coordinated DSH restart or supported safe loading
   boundary. `lib/index.js` and `lib/client.js` must exist. Building alone does
   not update an already running host. The
   [package README](../../../dsh/dsh-nmg/README.md) owns profile/build details.

The current package exposes `nmg_search`, `nmg_get`, `nmg_remember`, `nmg_state`,
optional Lab access and daemon health. Recall starts on inbox arrival; request
admission waits for bounded preparation, and the native loop refreshes
`systemPrompt.context` before committing content. State is prepared once for that
generation. A new inbox generation excludes the previous automatic fragment.

Final `tools/result` feeds shared AG observations and weak commit reminders.
Committed answers are attributed only at completed `turn/end`; canceled and
duplicate closers produce no attribution. Board discovery represents actual
Agent sessions. An empty adapter host is not an available Agent.

## OpenCode v2

Use `opencode-plugin/` from a persistent NMG checkout. The plugin exports
`index.ts` directly; it has no separate adapter build step. Prepare the checkout
and resident daemon using their normal setup, then configure the project or user
`opencode.json`:

```json
{"plugins":["C:/path/to/NodeMemoryGraph/opencode-plugin"]}
```

A directory link under `.opencode/plugins/` is another supported installation
path. Choose one registration. Start a fresh OpenCode service through the host's
supported procedure at a safe session boundary: its module cache means edits to
the checkout do not update an existing process. The plugin does not start or
stop the daemon. See the [adapter README](../../../opencode-plugin/README.md).

The Code Mode catalog uses explicit `nmg_` names. For example:

```javascript
const result = await tools.nmg_search({ query: "Which database did Atlas choose?" });
return result;
```

Native session lookup resolves project scope before first-turn recall; plugin
location is the fallback and `NMG_PROJECT_DIR` is an explicit override. If both
lookup and fallback lack a directory, recall lacks project scope. Prompt
preparation has a 1.5-second total budget; a late lookup cannot update current
scope. Rebuilt request contexts reuse the prepared fragment, while new prompts,
compaction and execution completion invalidate stale preparation as appropriate.
Manual native compaction followed by a new prompt has been exercised with current
state carriage; this does not establish every automatic or interrupted sequence.

## Check activation and diagnose failures

Start with a focused `nmg_search`, then `nmg_get` on one relevant result. An empty
search is valid; it does not prove the plugin failed to load. If testing state
carriage, use a disposable session and write a harmless complete state, then send
the next prompt. A model repeating its content is not final-send confirmation.

| Symptom | Next action |
| --- | --- |
| Missing tools | Check the selected profile/configuration, package path and fresh host activation. A configured path alone is not a setup receipt. |
| DSH cannot load `lib/index.js` | Build the source package, then coordinate loading that build. Do not edit a generated deployment copy. |
| OpenCode exposes short names or old behavior | Confirm the intended checkout is loaded once in a fresh service. Do not rely on `options.namespace` to prefix names. |
| State write returns `updated` but later context is missing | Check the native session connection, writer lease and next-turn boundary. Read current AG state through `nmg_state`; do not substitute another session's graph. |
| Scope is wrong | Check native session location and an unintended `NMG_PROJECT_DIR` override before searching again. |
| Unsupported capability or incompatible owner | Follow the reported compatibility boundary; do not remove fields to make a different operation pass. |

For a controlled integration check, use the retained
[native probe](../../../docs/experiments/runtime/native-plugin-capabilities-2026-11-12.md#reproduction)
with explicit installed paths and `--exercise-hooks`. It uses private NMG stores
and a loopback model. Keep verification isolated; do not test by restarting a
shared service or sending real conversations to a provider. API-only queries
without activation are insufficient to conclude that a plugin hook is unsupported.

Installed DSH core services and an actual OpenCode 2.0.32 host have scoped runtime
evidence. Live idle wake, fork/reset/reconnect generations and desktop loading
retain separate validation gates. Check the linked audit for the exact tested
surface instead of treating a passing fixture as full host coverage.

## Combine with Magpie

Magpie remains a complete independent NMG plugin target in the
[integration design](../../../docs/design/unified-architecture/magpie-integration.md).
This guide does not provide an installation command for an undelivered binding.
Native DSH/OpenCode state, memory tools and observations can operate independently
of that binding. For a validated combination, select one effect owner per
operation and share authorized session/disclosure context. Do not assume that
matching names joins sessions or enable a second automatic injector without a
supported handoff. GUI, token usage and tracing are separate enhancements.
