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

The plugin uses shared capability assembly and InformationView budgets. State is
prepared before optional recall and restored by compact-session/PostCompact hooks.
Board notices are batched at user prompts and at native Stop. An accepted Stop
batch can continue the turn once. Existing wake enablement, budgets and cooldowns
apply. Receipts cover the admitted fragment after output acceptance. A fully idle
chat waits for its next native event. Stop reports unknown processing state,
or busy after requesting continuation.

`nmg_remember action=feedback` accepts explicit labels and the rated activeGraphId.
The daemon reports whether the label could train its staged decision. Automatic
answer overlap is separate diagnostic telemetry. Stop supplies the native completed
answer. The adapter keeps up to 32 projection references per turn with statement
fingerprints. A daemon advertising `versioned-answer-attribution` validates ownership
and current content versions before deriving overlap. Interrupted turns are discarded.
This diagnostic does not label truth, task success or useful evidence.

Bash hooks can supply stdout without exit status. The adapter observes that output
with unknown outcome. At completion it can resolve the matching native call and
turn in a bounded transcript read, then observe its final status once. The tested
Codex 0.169 format is checked strictly. Unrecognized formats retain unknown outcome
and cannot trigger a successful-commit nudge. RPC work shares a four-second hook
deadline within Codex's five-second handler timeout. Preparation remains distinct
from final provider-input confirmation.

`NMG_DATA_DIR`, common recall/display settings and `NMG_ENABLE_COORDINATION`
retain their existing meanings. If the daemon is unavailable or incompatible,
tools report it and hooks skip optional context. Start/upgrade NMG through its
normal CLI at an appropriate point; the plugin does not replace a live owner.
