# Controlled code reload

[简体中文](controlled-code-reload.zh-CN.md) · [Terms used](controlled-code-reload.terms.yaml)

**Authority:** [Parent scope](../daemon-lifecycle-design.md#controlled-code-reload).

## Controlled code reload

This is a retained implementation protocol from the reviewed source branch, not evidence that this checkout supplies its CLI, capability or test files. This documentation PR adds no runtime implementation. The steps below apply only to an installed implementation whose CLI and authenticated discovery both explicitly support `controlled-reload`; they are not an unconditional operating procedure for the current version.


`nmg daemon reload [--db FILE | --data-dir DIR] [--json]` is an explicit administrative operation. It is not a file watcher, in-process module hot load, or alias for the legacy restart command. It loads the currently built CLI entrypoint and does not build source. The operator accepts clearing Active Graph state, writer leases and other process-local state; durable memories and task-board data remain.

1. The controller exclusively acquires the `<db>.reload.json` handover gate. The existing `<db>.server.json` remains the daemon endpoint identity; the gate is neither a second daemon descriptor nor a state store.
2. The current owner must advertise `controlled-reload` in its authenticated handshake. Without that capability, reload is refused without sending shutdown; the first upgrade needs a coordinated safe window.
3. `shutdown(reload=true, ticket)` validates the current gate ticket, stops domain-request admission and drains accepted calls. On drain timeout, the old service reopens; the controller neither starts a replacement nor force-kills the owner.
4. Only after the old process exits does the controller start a ticket-bearing child. Only that ticket may acquire the daemon lease while the gate is held. Success requires that child's endpoint and authenticated `hello` to become ready; another process cannot stand in for it.
5. Clients wait for handover before connecting, invoking a daemon or using CLI-local fallback. Endpoint changes refresh capability and ownership state; a controller's replacement is not attributed to a model client. The new owner must reject any stale Active Graph binding from the prior generation.

After a connection-level failure, an allowlisted read may retry once. If a mutation was dispatched but its result is unknown, the client refreshes the connection and reports that it was not replayed; it must not automatically duplicate publication, claim or write. Protocol and domain rejections do not trigger automatic upgrade. Participating clients and startup binaries must understand the gate; this is not a claim of arbitrary old-version hot migration.

Deadlines are explicit: drain 5 seconds, old-owner exit 5 seconds, replacement endpoint readiness 10 seconds, each `hello` 5 seconds, and client gate wait 30 seconds. A timeout is failure, never success; there is no force-kill or fallback to the old CLI. Normal failures release the controller's own gate. If the controller is killed, the gate is malformed, or owner identity is unreliable, fail closed: retain the file and require operator recovery instead of deleting the gate and starting another owner. Before recovery, confirm the old owner, controller and candidate child are stopped, or explicitly choose the single owner.

The [decision record](../../decisions/implemented/2026-10-13-daemon-controlled-reload.md) distinguishes this slice from in-process hot loading. Test source in `tests/cli/daemon-reload.test.ts`, `tests/cli/daemon-reload-client.test.ts` and `tests/cli/daemon-reload-process.test.ts` covers drain refusal/recovery, real CLI replacement, durable memory and board preservation, transient-state clearing, stale-binding rejection, competing starts and orphan gates, legacy-owner refusal, and no replay of uncertain writes. These isolated tests do not prove deployment of a shared production daemon.
