# Separate the NMG runtime from the embedding environment

[中文](2026-08-24-external-embedding-container.zh-CN.md)

**Status:** implemented

## Problem

The original Docker image bundled NMG, Python, CUDA-enabled PyTorch, Triton,
sentence-transformers, and BGE-small. The NMG application and model weights were
small, but the GPU runtime made the image about 11.62 GB in Docker Desktop's
storage accounting. Users with an existing local or hosted embedding endpoint
paid that cost without using the bundled service.

## Decision

Build two runtime targets from one Dockerfile:

- `external` contains only the Node/NMG runtime. It supports FTS-only operation
  or an external OpenAI-compatible embedding provider and does not contain
  Python, PyTorch, CUDA, or model weights.
- `bge` extends the same runtime with the pinned local BGE service. It remains
  the final/default target for backward-compatible `docker build .` behavior.

The shared entrypoint starts a local embedding server only when the image sets
`NMG_EMBED_LOCAL_SERVER=1`. The external target's health check owns only the NMG
daemon; an independent provider outage must not mark the durable store dead.

## Alternatives considered

- Ship only CPU and CUDA variants. This still forces every user to carry an
  embedding runtime and model even when a provider already exists.
- Make the external target the implicit default immediately. This is smaller but
  silently changes the meaning of the existing build command.
- Maintain two Dockerfiles. This duplicates the NMG runtime and makes dependency
  or entrypoint drift more likely.

## Consequences

The recommended integration base is `nmg:external`; the self-contained BGE image
remains available as a convenience. The external target requires explicit
provider configuration for semantic retrieval, but lexical FTS remains usable
without it. Python benchmark helpers are intentionally outside that runtime.
