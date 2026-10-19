# NMG Daemon Lifecycle Hardening Design (Idle Timeout / Automatic Relaunch / Count Warning)

[简体中文](daemon-lifecycle-design.zh-CN.md) · [Terms used](daemon-lifecycle-design.terms.yaml)

**Status:** current

**Updated:** 2026-10-13
**Related:** [STG isolated store](stg-isolated-store.md), [memory graphs](memory-graphs.md), [external-source design](external-source-design.md), [design overview](design.md)

## Background: the 2026-08-02 memory incident

During `run.ts locomo matched 99999`, Node exhausted memory: 98.2% of 63.7 GB physical memory, with working set above 100 GB. The incident report attributed it to:

- Each evaluation arm launched a detached daemon (`detached: true`, `child.unref()`) with its own SQLite path, so `readyState()` could not reuse another arm's process.
- There was no idle timeout; cleanup depended on HTTP `shutdown` or SIGTERM. The extension's `session_shutdown` hook was bypassed when `RpcClient.stop()` force-stopped children; Windows maps SIGTERM to `TerminateProcess`.
- The incident record lists 837 arms, two NMG modes and 1,670 `nmg.sqlite.server.json` descriptors. At an estimated 50–200 MB each, working set was about 100 GB.

**Design goal:** add daemon-side recovery as defense in depth, independent of whether the evaluation caller exits gracefully.

## Requirements

| ID | Requirement | Acceptance criterion |
| --- | --- | --- |
| R1 | Exit automatically after daemon idle time | After `N` seconds without requests, exit gracefully and release the lease. |
| R2 | Relaunch after idle exit | A client reconnecting to the same database can start a daemon with SQLite data intact; a daemon death mid-session can recover. |
| R3 | Detect excessive daemon count | Before spawning, count eligible daemons and warn on stderr above the default limit of 32. |

## Decision summary

| Requirement | Design | Setting | Default |
| --- | --- | --- | --- |
| R1 | In-daemon idle timer, refreshed on each request; timeout uses the server close path | `NMG_DAEMON_IDLE_TIMEOUT_MS` | `300000` (5 minutes; `<=0` disables) |
| R2 | Reuse `readyState()` and stale-lease cleanup; add one connection-level reconnect | None; fixed behavior | — |
| R3 | Before spawn, scan the resolved NMG data root and warn above the limit; do not block spawn | `NMG_DAEMON_LIMIT` | `32` (`<=0` disables) |

## R1: Daemon idle timeout

### Behavior

- Start the timer at daemon startup, even before the first request, so a client that dies immediately after spawn does not leave an immortal daemon.
- Refresh the timer before handling each arriving HTTP request, including `hello`; response completion does not refresh it.
- Timeout uses the shutdown close helper: `server.close()` stops new connections, then `closeAllConnections()` closes HTTP connections. After `closed` resolves, `lease.release()` removes `*.server.json`; `serveHttp` returns and `daemon run` exits 0.
- A `closing` flag prevents duplicate close paths from racing.
- **In-flight request boundary:** the design intends not to interrupt accepted work, but the current helper calls `closeAllConnections()`. A long request may be interrupted; current idle tests do not cover this case.

### Implementation location

`src/cli/http-server.ts`, `serveHttp`:

```ts
const idleTimeoutMs = options.idleTimeoutMs ?? daemonIdleTimeoutMs();
let idleTimer: NodeJS.Timeout | undefined;
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  clearTimeout(idleTimer);
  server.close(resolveClosed);
  server.closeAllConnections?.();
};
const touch = () => {
  if (closing) return;
  clearTimeout(idleTimer);
  idleTimer = idleTimeoutMs > 0 ? setTimeout(close, idleTimeoutMs) : undefined;
};
// touch at startup and before handling each request
```

`daemonIdleTimeoutMs()` reads `NMG_DAEMON_IDLE_TIMEOUT_MS`; invalid input falls back to the default. `options.idleTimeoutMs` is a test-only injection point.

### Why the default is five minutes

| Scenario | Rationale |
| --- | --- |
| Interactive `nmg daemon start` | A user may think for a while before returning; five minutes is a reasonable starting point. |
| One-prompt evaluation arm | The daemon becomes unused after the arm; lower the timeout (for example, to 60 seconds) for faster reclamation. |
| Long model-thinking gap between NMG calls | Gaps are usually under five minutes; if the daemon does exit, R2 provides a reconnect path. |

### Alternatives not selected

| Alternative | Reason |
| --- | --- |
| Poll the parent process ID | The daemon is detached; PPID semantics are unreliable on Windows, and the spawning CLI child is short-lived. Exiting with that parent would break multiple connections within one evaluation arm. |
| Fixed lifetime from startup | A long session could be killed even while active; it does not distinguish activity from idleness. |

## R2: Relaunch after timeout — conclusion: yes

### Existing mechanisms

1. **Liveness:** `readyState()` reuses only a descriptor whose PID passes `isProcessAlive`; a dead owner follows the spawn path.
2. **Stale lease:** `acquireServerLease()` creates `*.server.json` with `wx`. On `EEXIST`, a live PID blocks a second daemon; a dead PID allows removal and retry.
3. **Data recovery:** the replacement uses the same `--db`, preserving SQLite memory and board data, but not Active Graph state, writer leases or other process-local state. It gets a new token and port, rediscovered through `server.json`.

### Added: connection-level reconnect

A client may outlive its daemon while the agent is thinking. It rediscovers the endpoint and `hello` capabilities for the same `databasePath`, then updates its connection object. It may spawn a replacement only after the previous owner has exited; a transient endpoint fault while the owner is alive must not create a second writer.

`invokeDaemon` waits for handover and refreshes a changed owner before checking capabilities. If no request was sent, it can use the new owner. If a request was sent but its response was lost, only the [client's read allowlist](../../src/cli/daemon-client.ts) is retried once. An uncertain mutation returns an explicit error and is not replayed. HTTP, protocol and domain rejections are not retried; a missing capability does not trigger an implicit upgrade.

### Reconnect ownership semantics

- A replacement spawned by reconnect has `startedByCaller=true`; the extension's `session_shutdown` can therefore close it through `shutdownOwnedDaemon`. This matches the evaluation case where each `cli.js` child owns its arm daemon.
- If this process started the original daemon and it has exited, the replacement belongs to the same process; ownership is not ambiguous.

## R3: Daemon-count warning (default 32; warning only)

### Trigger and behavior

- Count before spawning a new daemon; a reuse path does not add a process and is not counted.
- If the count is greater than `NMG_DAEMON_LIMIT` (default 32), write a warning to **stderr** but do not block spawn. Warn once per process to avoid flooding output during thousands of connection calls.

```text
NMG: warning: 1670 NMG daemons running (limit 32); raise NMG_DAEMON_LIMIT or stop stale daemons (`nmg daemon stop --data-dir <dir>`)
```

`RpcClient` captures the child stderr and forwards it to the evaluation process.

### Counting implementation and current coverage boundary

- **Scan root:** `daemonScanRoots()` returns only `resolveNmgDataDir()` (default `~/.nmg`, overridable by `NMG_DATA_DIR`), not `process.cwd()`. Counts cover that root only. A nearby comment still mentions `cwd`; the function does not, so this is not a global count.
- Recursively find `*.server.json`, skip `node_modules`, `.git`, `dist`, `coverage`, `.nmg` and `build`, and select HTTP descriptors with a valid host, port, token and live PID. The implementation then checks each candidate with authenticated `hello` (250 ms timeout) and deduplicates by endpoint.
- A module-level memo has a **1-second TTL**. Current counting includes synchronous tree traversal and parallel authenticated `hello` checks; the earlier 50–200 ms estimate is not a current end-to-end measurement.
- The scan is read-only and has no cross-process registry or coordination, avoiding stale registry entries and lock contention.

### Why the default is 32

The recorded rationale was 16-way evaluation concurrency × two NMG arms = 32 daemons. The warning should stay quiet at that planned capacity; higher counts may indicate leakage or duplicate runs. `NMG_DAEMON_LIMIT<=0` disables it. This is not a hard cap.

### Alternatives and the current scope gap

| Alternative | Rationale / current status |
| --- | --- |
| PID registry file | No cross-process atomicity; force-kills leave stale entries; duplicates the existing `*.server.json` evidence. |
| Block spawn above the limit | Rejected by the requirement, which calls for warning only; legal simultaneous launches could be blocked. `NMG_DAEMON_LIMIT_BLOCK` remains a possible later option. |
| Scan only the resolved `NMG_DATA_DIR` | The earlier design rejected this because evaluation-arm databases may live under a project tree. The current `daemonScanRoots()` nevertheless returns only the resolved data root, so the warning can miss daemons outside it; project-root coverage remains an implementation gap. |

## File change inventory

| File | Change |
| --- | --- |
| `src/cli/http-server.ts` | Idle timer, `touch`/`close`/`closing`, environment parsing; `httpHandler` keeps its signature. |
| `src/cli/daemon-client.ts` | `DaemonConnection.databasePath`; pre-spawn count/warning; connection-level reconnect; `countRunningDaemons`, memo and environment parsing. |
| `tests/cli/process.test.ts` | Process tests for idle exit, relaunch, count warning and reconnect. |
| `tests/cli/http-boundary.test.ts` | Preserve the daemon-client boundary: imports remain limited to `./http-client.ts` and `./lifecycle.ts` rather than `../core/*`. |
| `src/cli/main.ts` | `waitForState` checks `isProcessAlive(pid)` so a stale descriptor is not mistaken for a live daemon. |
| Design document and `evals/README.md` | Record `NMG_DAEMON_IDLE_TIMEOUT_MS` and `NMG_DAEMON_LIMIT`. |

## Test plan

| Case | Method | Assertion |
| --- | --- | --- |
| Idle exit | Start with `NMG_DAEMON_IDLE_TIMEOUT_MS=1000`; wait about 1.5 seconds. | `daemon status --json` reports `running:false`; `*.server.json` is removed. |
| Request refreshes timer | With idle timeout 2 seconds, send `hello`/`status` at 1 second and another request at 3 seconds. | The later call succeeds because the timer was refreshed. |
| Relaunch after idle exit | After the preceding daemon exits, reconnect or run `daemon start`. | New PID; `remember`/`search` still return the stored data. |
| Stale lease | Write a `*.server.json` descriptor for a dead PID, then run `daemon start`. | The stale file is removed and the daemon starts. |
| Count warning | Start real daemons under a temporary `NMG_DATA_DIR`, then trigger a new spawn with `NMG_DAEMON_LIMIT=1`; also use a high limit and `0`. | Authenticated daemons above the threshold warn; a high limit or `0` is quiet. A live PID alone is not enough to count. |
| Connection reconnect | Start a daemon, stop it, then invoke a client operation. | A new daemon is started and the read returns successfully. |
| Boundary guard | Run `tests/cli/http-boundary.test.ts`. | No regression; daemon client does not gain a core dependency. |

## Incident-reproduction acceptance observation

**Recorded local run (2026-08-02 17:37):** with `NMG_BENCH_CONCURRENCY=4 NMG_DAEMON_IDLE_TIMEOUT_MS=60000 NMG_DAEMON_LIMIT=4`, `npm run eval:locomo -- matched 1` ran 5 cases × 3 modes (15 arms), using `deepseek-v4-flash`, and completed in about 90 seconds.

| Metric | Recorded observation |
| --- | --- |
| Peak RPC children | 4, equal to the configured concurrency. |
| Peak NMG daemons | About 9: roughly concurrency × 2 plus older daemons still inside the idle window. |
| After evaluation | Daemons exited in batches within 60 seconds; a two-hour observation showed one user-level `~/.nmg` baseline daemon and no arm leftovers. |
| Count warning | With limit 4, warnings were observed at counts 5 and 6; the then-counted scope included the baseline daemon. |
| Evaluation answers | 15/15 rows had an answer; 0 `answerError`. |
| Memory | About 19 GB during evaluation, falling after it ended; 44.5/63.7 GB available. |

This single local observation is not a general memory/performance guarantee and does not verify scanner coverage for other data roots or current scan latency. It supports the targeted mitigation in that run, not a universal count claim.

Follow-up reproduction plan:

1. Run `NMG_BENCH_CONCURRENCY=16 nm npm run eval:locomo -- matched 5`.
2. Observe `node.exe` while running; daemon peak should be near concurrency × 2 (at most 32 for that setup), then fall as arms complete.
3. Confirm the process count does not grow monotonically and memory does not keep expanding with elapsed time.
4. Kill a daemon with `stopServer`; the next NMG call should relaunch it without failing the evaluation.
5. Lower `NMG_DAEMON_LIMIT` to observe a warning; normal settings should stay quiet for the intended workload.

## Out of scope / later work

- **Explicit evaluation-side cleanup** (`shutdownOwnedDaemon` in `evaluate()` `finally`, or scanning stale daemons before launch): daemon-side recovery is defense in depth; caller cleanup remains a separate, complementary change.
- **Daemon reuse** across the three matched arms using a shared seed database/daemon: a structural reduction in spawn count, separate from this work.
- **Hard blocking limit:** may be added later as `NMG_DAEMON_LIMIT_BLOCK` if required.

## Controlled code reload

Read the complete responsibility: [Controlled code reload](daemon-lifecycle-design/controlled-code-reload.md).

## Implementation lineage

- **Introduced — `39516537`:** resident CLI daemon lifecycle.
- **Superseded — `9444a3c1` → `692fe85c`:** gRPC transport was replaced by cross-platform HTTP JSON-RPC; protocol semantics remain in `src/cli/protocol.ts`.
- **Hardened — `80167da9`, `a5787cd6`, `30e273e8`:** owned shutdown, idle exit and reconnect converged.
- **Hardened — `11e2101f`:** stale protocol fails closed instead of silently accepting a new client.
- **Hardened — `9a911d00`, `ac2d1114`:** aligned SQLite single-writer/STG concurrency and stable longest-prefix routing for nested CLI commands.

Full historical classification is in [implementation lineage](implementation-lineage.md).
