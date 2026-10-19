# Session-memory lifecycle hooks: historical design index

[English](session-memory-lifecycle-hooks-2026-08-10.md) | [简体中文](session-memory-lifecycle-hooks-2026-08-10.zh-CN.md) · [Terms](session-memory-lifecycle-hooks-2026-08-10.terms.yaml)

Historical design note begun on 2026-08-10 and expanded with later implementation observations. It is an index to current owners, not a current Pi extension API reference or an implementation checklist. Earlier event inventories, test labels, and commit references are time-bounded records, not fresh verification.

## Design boundary retained here

The note distinguishes session working context from durable memory. Tool output may help an Agent continue work, but tool execution alone does not qualify that output as a durable memory. Compaction is likewise not a reason to copy raw conversation fragments into LTG; Pi owns its conversation summary, while NMG-specific working state and any durable `nmg_remember` decision follow their own contracts.

A session reasoning workspace is an optional Lab scratch surface, separate from LTG memory. It must not be conflated with the Agent working-state projection, the shared Task Board, or an automatic memory-write path. First-response timing is also a separate, opt-in observation feature, not a memory lifecycle hook that changes retrieval behavior.

## Current owner map

- Capture, recall, and the session working-state boundary: [Memory loop design](memory-loop-design.md) and [session active-graph runtime](session-active-graph-runtime-design.md).
- Agent-visible information views: [context-information decision](../decisions/implemented/2026-10-13-context-information-views.md).
- Working-state admission and daily use: [working-state decision](../decisions/implemented/2026-10-08-ag-working-state.md) and [daily-use decision](../decisions/implemented/2026-10-12-working-state-daily-use.md).
- Session reasoning scratch and compaction checkpoints: [reasoning workspace design](design/session-reasoning-workspace-and-compaction-checkpoint.md).
- First-response timing: [opt-in observation decision](../decisions/implemented/2026-10-04-first-response-timing-is-opt-in.md).
- Current hook wiring and lifecycle payload handling: [Pi NMG extension](../../.pi/extensions/nmg/index.ts), [reasoning-workspace service](../../src/integration/reasoning-workspaces.ts), and [daemon service](../../src/cli/service.ts).

## Evidence boundary

The original note included a 33-event Pi lifecycle inventory and detailed implementation observations. Extension event names and payloads can change; consult the currently installed Pi API and current extension source before relying on an event-level claim. Historical “implemented” or “tests passed” labels describe the dated report only. This index makes no new claim that every listed behavior was re-tested in this documentation pass.

Use [implementation lineage](implementation-lineage.md) to locate current source ownership. The historical design is retained to explain why temporary session context, explicit durable memory, optional reasoning scratch, and measurement instrumentation are separate concerns.