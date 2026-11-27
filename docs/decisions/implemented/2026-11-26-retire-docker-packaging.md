# Retire unmaintained Docker packaging

[中文](2026-11-26-retire-docker-packaging.zh-CN.md) · [Terms used](2026-11-26-retire-docker-packaging.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Supersedes:** [separate the NMG runtime from the embedding environment](../archived/2026-08-24-external-embedding-container.md)

## Problem

The repository carried two identical, unmaintained copies of `Dockerfile` (`Dockerfile` and `docker/Dockerfile`), `.dockerignore`, `docker/entrypoint.sh`, and a regex-only check in `tests/docker/container-definition.test.ts`. That packaging no longer worked and conflicted with NMG's native execution model:

1. `npm run build` executes `scripts/generate-prompts.ts`, so `COPY src ./src` without `scripts/` broke every `docker build .` run before compilation finished.
2. `docker/entrypoint.sh` launched `nmg daemon run`, which binds only `127.0.0.1` on an ephemeral port paired with host filesystem lease files—unusable from host agent adapters outside a container.
3. The default target built Python and CUDA PyTorch (`cu126`) alongside `evals/omnimemeval/bge_server.py`, giving first-time readers and tools the false impression that NMG requires heavy container infrastructure.

## Decision

Remove `Dockerfile`, `.dockerignore`, `docker/`, and `tests/docker/`, drop `tests/docker/**/*.test.ts` globs from `package.json`, archive `2026-08-24-external-embedding-container`, and standardize on NMG's native execution paths: built-in `node:sqlite` on Windows/macOS/Linux, `nmg http` for explicit HTTP endpoints, and `onlion` WASM SQLite for stateless edge workers.

## Alternatives considered

1. **Fix `COPY scripts ./scripts` and switch the default target to `external` (Node-only image):** Rejected because there is no active container deployment target today, and maintaining an unused `Dockerfile` invites silent drift again.
2. **Keep `Dockerfile` only for `evals/` Python benchmarks:** Rejected because evaluation scripts already invoke Python and `node` directly without container isolation.

## Consequences

- Root-level repository clutter and unverified container definitions are gone, matching the native zero-Docker runtime model described in `README.md`.
- If containerized `nmg http` deployment is later desired on Linux servers, a minimal Dockerfile can be reintroduced specifically around `nmg http --config` rather than `daemon run`.
