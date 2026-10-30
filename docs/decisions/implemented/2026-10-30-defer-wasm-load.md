# SQLite is loaded by the requests that need it

[简体中文](2026-10-30-defer-wasm-load.zh-CN.md) · [Terms](2026-10-30-defer-wasm-load.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Measured on the live endpoint before this change: **twelve sequential `/health` calls took
3.6-6.5 s each**. Every one of them is a cold start, because this platform starts a **fresh isolate
per request** (every log line carries `instance.seq = 1` next to a container uptime in the
thousands of seconds). So that figure was paid per request, not once per container, and it was
spent on SQLite that `/health` does not use:

1. `healthResponse` called `sqliteReady()` before answering, purely to report
   `sqlite.version.libVersion`.
2. The EdgeOne build inlined the wasm as base64 and emitted
   `export default new WebAssembly.Module(Buffer.from(<base64>, "base64"))` **at module scope** -
   the plugin's comment said "lazily built", the emitted code was eager. A 1.6 MiB base64 decode
   plus a wasm compile therefore ran before any handler.

The harness preflight is `/health`. It was the most expensive route in the service.

## Decision

- The build emits a **factory**: `encodedBytes` stays a string literal (cheap), and
  `compiledWasm()` decodes and compiles on first call.
- `worker.mjs` accepts either shape - a factory, or workerd's precompiled module in the wrangler
  build - so the two build paths stay one code path.
- `/health` does not load SQLite; it answers "deferred until a request needs it" instead of a
  version string it did not read.
- The always-on request line carries `sqlite_loaded`, so the claim is falsifiable: `false` means
  that request finished without decoding or compiling wasm at all.

## Evidence

| before                                                                                                                 | after                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/health` x12 on live: 3.617 / 3.839 / 3.772 / 6.482 / 4.301 / 4.729 / 5.861 / 6.039 / 5.143 / 3.745 / 4.249 / 3.604 s | to be measured after deploy; `sqlite_loaded: false` on the metadata routes is asserted in the suite |
| suite: metadata routes logged `sqlite_loaded: false`                                                                   | same assertion, now also checkable in the platform log per request                                  |

## What this does and does not establish

- It removes the wasm decode/compile from routes that never touch a database. It does **not** make
  a database request cheaper: `/add` and `/search` still load SQLite, and on a fresh-isolate-per-
  request platform they still pay for it on every call. That is the next lever, and it is a
  different design (a runtime that keeps the isolate alive, or no wasm at all).
- The 3.6-6.5 s figure includes container start and network; only the delta after deploy is
  attributable to this change.
- Nothing here addresses the 53 ms / 54.48 MB fast failures: those invocations never reached the
  handler.

## Alternatives considered

- **Keep the eager module and only drop `sqliteReady()` from `/health`.** Half the cost: the
  base64 decode and compile still run at module scope, so the route would stay slow.
- **Ship the wasm as a separate file and read it lazily.** The EdgeOne build deliberately inlines
  everything ("removes every filesystem-path assumption"): the function is a single module in
  `/var/user`, and file access there is not a contract. Keeping the bytes inline but decoded late
  gets the same win without reintroducing a path dependency.
- **Cache the compiled module across requests.** Not possible: the isolate is per request, so a
  module-level cache is per request by definition.

## Consequences

- `/health` no longer reports `sqlite.version.libVersion`; it reports that the load is deferred.
  Any client that parsed that field must read the version from `/admin/status` instead - the
  harness only reads the status code.
- `sqlite_loaded` is one boolean on the request line; no extra allocation, no memory sampling.
- The wrangler build is untouched in behaviour: workerd still compiles the module and
  `worker.mjs` uses the object directly.

## Correction and follow-up (same day)

Two defects and two further transforms, all found on the deployed endpoint rather than by the suite:

1. **`callbacks.wasm` had to stay eager.** The first version of the plugin matched every `*.wasm`,
   so the 19 KB callbacks module also became a factory. The generated loader imports it as a real
   `WebAssembly.Module`, so `new WebAssembly.Instance(fn, ...)` threw inside
   `runSQLite3PostLoadInit` and every `/search` that needed SQLite answered **503 in 75-150 ms**
   while `/add` kept succeeding. Only `sqlite3.wasm` is deferred now.
2. **`/health` alone was not enough.** A search loaded SQLite before reading anything, and a user
   whose writes are still in the log has no partitions at all - the harness's first questions are
   exactly that. `readSearchCandidates` now takes a memoised `getSqlite` and resolves it inside the
   partition loop. Verified: a search for an unknown user returns 200 in 19 ms with
   `sqlite_loaded: false`.
3. **The OPFS installers are now skipped, not attempted.** Every SQLite load tried twice and threw
   twice (no `location` in this runtime), printing two stack traces per cold start. The loader gates
   them on `config.disable.vfs`, whose source is `globalThis.sqlite3ApiConfig` (worker-loader 3064,
   gates at 15699 and 16964) - **not** `init()`'s argument, which is why passing it there changed
   nothing. Verified: two stacks per load became zero (22 log lines to 0 in a full verify run).

Measured after deploying all of it (revision `8d08df7c`): `/health` 2.2-5.3 s across ten cold
starts, an unknown-user search 200 in 2.2-4.3 s, and the platform's own log shows `/health` at
**25 ms / 88 MB** on a warm container. The residual seconds are container start and network, not wasm:
`sqlite_loaded` is `false` on those requests.

### What did not change

- `mutateUser` still awaits `sqliteReady()` up front, although `releasePending` and
  `reconcilePending` never touch a database. Deferring it means threading a thunk through
  `runPart`/`openPart` in `storage.mjs`; the paths that benefit are fold housekeeping, which runs
  rarely. Left as a documented candidate rather than a rushed change.
- The `/capacity` check in `npm run test:edgeone` expects `sqlite_bytes.used > 0` for a user that
  has only log entries (it predates the log-mode default, where a fresh user has no manifest). That
  is a stale test expectation, not a runtime defect.
