# NMG plugin for WorkBuddy

[中文](README.zh-CN.md) · [Terms used](README.terms.yaml)

The WorkBuddy integration surface for NMG (Node Memory Graph), a Claude Code-compatible host, has three layers:

| Layer | Implementation |
|---|---|
| Tools | MCP connector reusing `claude-plugins/nmg-memory` (see its `CLAUDE.md` for registration). |
| Knowledge | Skill sync: `npm run skill:nmg:sync -- --target ~/.workbuddy/skills/nmg-memory`. |
| Events | `nmg-hook.ts` in this directory, registered in the `hooks` field of `~/.workbuddy/settings.json`. |

## Hook behavior

- **UserPromptSubmit**: automatic recall hint (small-budget search: `limit 13`, `maxTier 1`, `graphHops 1`; injects compact headers from the shared Agent Surface and folds repeated IDs per session), agent identity registration, and Task Board wake polling. The hook and MCP do not share a host session. The hook uses the namespaced identity `workbuddy-hook:<sessionId>`; the injected `activeGraphId` belongs to that separate AG and must not be passed to MCP-side `nmg_get`. To load exact evidence, the model must first call MCP-side `nmg_search` to create a projection for the current tool session, then call `nmg_get`.
- **PreToolUse(Bash)**: a reminder to call `remember` after `git commit`.

The hook is passive: it calls the daemon only when a live HTTP lease exists (`<dataDir>/nmg.sqlite.server.json` with a live PID), never starts the daemon, accepts only `127.0.0.1`, sends `hello` first and checks the compatibility epoch, silently handles failures, and always exits 0. Automatic recall uses a separate namespaced hook session. The current hook path does not send a `release` RPC, so do not claim that the in-memory AG is released immediately after rendering. Candidate rendering uses the shared surface in `src/integration/agent-surface.ts`; it does not hand-build strings. See the integration recipe in `skills/nmg-memory/references/harness-adapters.md`.

Recall hello, search and disclosure share one absolute five-second waiting budget; later-phase expiry preserves timely candidates. Identity registration and wake polling are outside that function's budget, and explicit MCP search is not bounded by the automatic deadline. The [waiting-budget contract](../docs/design/session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.md) owns cancellation and synchronous-work limits.

## Registration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node --experimental-strip-types <repo>/workbuddy-plugin/nmg-hook.ts", "timeout": 10 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node --experimental-strip-types <repo>/workbuddy-plugin/nmg-hook.ts", "timeout": 10 }] }
    ]
  }
}
```

Optional environment variables: `NMG_DATA_DIR` (default `~/.nmg`), `NMG_AGENT_ID` / `NMG_AGENT_CAPABILITIES` (board identity), and `NMG_ENABLE_COORDINATION=0` (disables identity registration and board coordination only; automatic recall remains enabled). The board-wake switch shares `<dataDir>/board-wake.json` with Pi/Kimi.

## Known pitfalls

- In WorkBuddy's managed environment, deleting the lock file during `skill:nmg:sync` can be blocked by the safe-delete shim even though the skill files were synchronized. Remove the leftover `.nmg-memory.sync-*` manually; `--check` can verify consistency.
- Sandbox isolation may block reads/writes to `~/.nmg` state files. A deduplication-state failure does not affect correctness; it can cause repeated injection.
