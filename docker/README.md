# NMG containers

The Dockerfile provides one lightweight NMG runtime and one self-contained local
embedding image. Both run exactly one NMG daemon for one mounted database.

## External-provider image (recommended base)

The `external` target contains Node.js and NMG only. It deliberately excludes
Python, PyTorch, CUDA, sentence-transformers, and model weights. Without embedding
configuration it uses built-in SQLite FTS5 retrieval.

```sh
docker build --target external -t nmg:external .
docker run --rm --name nmg -v nmg-data:/data nmg:external
```

To use an OpenAI-compatible embedding service, provide its URL and model. From a
Docker Desktop container, `host.docker.internal` reaches a service running on the
Windows or macOS host:

```sh
docker run --rm --name nmg \
  -v nmg-data:/data \
  -e NMG_EMBED_BASE_URL=http://host.docker.internal:8000/v1 \
  -e NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5 \
  -e NMG_EMBED_PROFILE=bge-en \
  nmg:external
```

On Linux, put both containers on the same user-defined Docker network and use
the embedding container name in `NMG_EMBED_BASE_URL`, or explicitly map the host
gateway. Authentication can be supplied with `NMG_EMBED_API_KEY`.

The external provider is intentionally outside this container's health boundary:
the health check verifies the NMG daemon only. Provider outages preserve FTS
search and leave failed embedding work observable/retryable rather than marking
the memory store itself dead.

## Self-contained local BGE image

The final/default `bge` target downloads a pinned BGE-small model during build
and runs it beside NMG. Runtime startup needs no model network access. Its default
CUDA-enabled PyTorch stack is large because it contains CUDA libraries, Torch,
and Triton even when runtime falls back to CPU.

```sh
docker build -t nmg:bge .
docker run --rm --name nmg -v nmg-data:/data nmg:bge
```

Use an NVIDIA GPU when NVIDIA Container Toolkit is configured:

```sh
docker run --rm --name nmg --gpus all -v nmg-data:/data nmg:bge
```

For a smaller self-contained CPU-only image:

```sh
docker build \
  --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu \
  -t nmg:bge-cpu .
```

The BGE startup log reports `device=cuda` or `device=cpu`. This target's health
check covers both the local embedding endpoint and the NMG daemon.

## Embedding synchronization

Both targets enable `NMG_EMBED_AUTO_SYNC=1`: each accepted `remember` schedules
an incremental, deduplicated record-index update when an embedding provider is
configured. Outside these images auto-sync remains opt-in, so provider
configuration does not silently alter a normal host installation.

See [online embedding design](../docs/design/online-embeddings.md) for provider
configuration and indexing behavior.

## Process and storage boundary

- One container starts one NMG daemon for `/data/nmg.sqlite`.
- The database lease rejects a second daemon for the same database.
- Multiple containers are supported when each uses a separate volume.
- Agents and sessions share the daemon and use NMG ownership/scope boundaries;
  they do not start one daemon per session.
- Python benchmark helpers belong to the evaluation environment and are not
  available in the `external` runtime image.

These are reproducible NMG runtimes, not Agent Memory Leaderboard Add/Search
servers. A benchmark adapter should connect through the existing daemon client
rather than opening a second `NmgService` against the same SQLite database.
