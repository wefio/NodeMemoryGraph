# NMG for Codex

[中文](README.zh-CN.md)

This plugin supplies NMG memory/state tools and native recall, maintained-state
and coordination hooks. Node.js 22.19+ must be on PATH and a compatible local
NMG daemon must already be running. The bundled client has no runtime dependency
on this checkout or node_modules. It never starts or stops a shared daemon.

## Build and distribute

From a prepared NMG checkout:

```text
npm run codex:package -- --output ./releases/codex
```

Distribute the generated `.tgz`, or its complete `plugin/` directory. Extract the
archive before adding its `package/` directory as a local marketplace. It contains
the compiled client, complete Skill, hooks, manifests and marketplace catalog.
Repository-owner links in copied Skill references point to GitHub; operational
Skill references remain local. Source files in `codex-plugin/` are build inputs,
so install the generated package.

## Install

For the generated directory, or extracted archive directory:

```text
codex plugin marketplace add <plugin-directory>
codex plugin add nmg@nmg-local
```

Enable `hooks = true` under `[features]` in Codex configuration, and use `/hooks`
to review and trust the installed hook definitions. Updating scripts requires a
new review. Approve the MCP tools you intend to use through normal Codex policy.
The plugin ships no approval bypass or automatic trust changes.

Use a fresh/reloaded Codex session after installation. Current tested engines
require the `.codex-plugin` compatibility layout for hook discovery. The generated
package intentionally uses that layout. Normal tools still work when hooks are
disabled; automatic context and prompt-time coordination require hooks.

## Sessions and lifecycle

MCP calls use Codex's native transport metadata; hooks use native session/turn
fields. Global `NMG_SESSION_ID` and `NMG_AGENT_ID` cannot collapse Codex chats.
New/forked native IDs have distinct AG state, while resuming the same ID keeps
its binding. Native clear starts a new NMG generation and old-generation calls
are refused. Its new turn must pass hook admission.

Routing metadata under `<NMG data>/codex-sessions/` stores the current generation
and at most 128 admitted turn scopes per chat. It contains no memory text or
credentials. Writer leases, AG state and evidence remain in the daemon.
Without a hook admission, explicit tools retain session isolation and leave
project scope unknown. Project scope is never guessed from prompt text.

The plugin uses the shared capability assembly and InformationView budgets.
Automatic preparation does not confirm final disclosure. State is prepared
independently of optional recall and is restored after compaction. Board notices
are batched at user prompts, with receipts only after the output sink accepts
them. This adapter provides no idle wake. Stop reports unknown processing state.
Generic tool observations require recognized result flags; ambiguous outcomes
cannot produce successful-commit nudges. Answer attribution is not advertised.

`NMG_DATA_DIR`, common recall/display settings and `NMG_ENABLE_COORDINATION`
retain their existing meanings. If the daemon is unavailable or incompatible,
tools report it and hooks skip optional context. Start/upgrade NMG through its
normal CLI at an appropriate point; the plugin does not replace a live owner.
