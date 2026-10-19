# NMG plugin for Kimi Code CLI

[English](README.md) | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

NMG hooks for Kimi Code fill in event hooks that Kimi lacks. They provide three functions:

1. **Write reminder:** When `git commit` or completion-like keywords are detected, append a soft reminder to the context suggesting that the agent can use `nmg_remember` to save the outcome of the current turn. This is a reminder, not a forced write (equivalent to the completion nudge in the Pi extension).
2. **Degraded board wake:** On every `UserPromptSubmit`, poll the daemon's Task Board—the world channel and channels subscribed to by this session—and append a notification when a new open entry has not already been delivered. The Pi extension uses a background timer and idle detection; Kimi hooks have no background timer, so a notification arrives on the "next user message," not immediately. The protocol matches Pi: skip the agent's own echoes, claimed entries, and broadcast entries; deduplicate with `deliveryCheck`; and write a `recordDelivery` receipt after notification so the same entry does not interrupt again.
3. **System-level identity:** On every `UserPromptSubmit`, report Kimi's stable `NMG_AGENT_ID` and optional `NMG_AGENT_CAPABILITIES` to an already-running daemon. Registration does not require wake to be enabled, emits no context, and does not start the daemon; this lets MCP's `nmg_board discover` find a Kimi session that is online only through its hook.

Kimi's tool surface (`nmg_search` / `nmg_get` / `nmg_remember` / `nmg_board`) is provided by the MCP server (the `nmg` entry in `.mcp.json`). This directory adds only event hooks.

## Wake controls

Wake is enabled by default so a new Agent can discover shared work without manual setup. Set `enabled` to `false` in `<data directory>/board-wake.json` to turn it off. This is the same file used by the Pi extension's `/nmg wake off` command, so one setting controls both:

```json
{ "enabled": false, "budget": 8, "cooldownMs": 600000 }
```

`budget` is the daily notification limit (`0` = unlimited); `cooldownMs` is the minimum interval between notifications (`0` = no cooldown). The hook's own budget/cooldown state is stored in `kimi-board-wake-state.json` and does not consume Pi's wake state. The hook is passive: if the daemon is not running, it silently skips the work and never starts the daemon for you.

## Files

- `nmg-hook.mjs` — zero-dependency hook script that handles two **flow-affecting** events:
  - `UserPromptSubmit`: completion-like keywords (完成了/收工/committed/done…) and board-wake polling;
  - `PreToolUse` (matcher `Bash`): a command containing `git commit`.

When triggered, the hook writes a reminder/notification to stdout (exit code `0` = allow; stdout text is appended to the context). `PostToolUse` is observational and its output is discarded, so the git-commit reminder is attached to `PreToolUse` instead.

## Installation

Append the two `[[hooks]]` sections from `config.example.toml` to `~/.kimi-code/config.toml`, then replace the command paths with absolute paths to this repository. Quote Windows paths (Kimi runs hook commands through `cmd.exe` on Windows). Restart the session for the changes to take effect.

## Verification

```bash
# Should print <nmg_nudge> reminder text
echo '{"hook_event_name":"UserPromptSubmit","prompt":"完成了"}' | node kimi-plugin/nmg-hook.mjs
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | node kimi-plugin/nmg-hook.mjs
# Should print nothing (exit code is still 0; fail-open)
echo '{"hook_event_name":"UserPromptSubmit","prompt":"继续"}' | node kimi-plugin/nmg-hook.mjs
```

## Notes

- The hook always exits with code `0` and never blocks an operation; Kimi also fails open if the script errors.
- Event names, `matcher`, and exit-code semantics follow the official hooks documentation. `[[hooks]]` accepts only the four fields `event` / `matcher` / `command` / `timeout`; extra fields cause configuration loading to fail.
