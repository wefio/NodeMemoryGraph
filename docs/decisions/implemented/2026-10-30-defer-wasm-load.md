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
