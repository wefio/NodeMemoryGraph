# NMG + local BGE container

This image runs exactly one NMG daemon and one local embedding server. The BGE
model is downloaded at build time, pinned to a Hugging Face revision, and saved
inside the image so runtime startup does not require network access.

## Build

The default image installs a CUDA-enabled PyTorch wheel. At runtime the BGE
server uses CUDA when Docker exposes a compatible NVIDIA GPU and otherwise
falls back to CPU.

```sh
docker build -t nmg:bge .
```

For a smaller CPU-only image:

```sh
docker build \
  --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu \
  -t nmg:bge-cpu .
```

## Run

CPU or automatic fallback:

```sh
docker run --rm --name nmg -v nmg-data:/data nmg:bge
```

Use an NVIDIA GPU when the host has NVIDIA Container Toolkit configured:

```sh
docker run --rm --name nmg --gpus all -v nmg-data:/data nmg:bge
```

The BGE startup log reports `device=cuda` or `device=cpu`. Docker health checks
both the embedding endpoint and the NMG daemon.

## Process and storage boundary

- One container starts one NMG daemon for `/data/nmg.sqlite`.
- The database lease rejects a second daemon for the same database.
- Multiple containers are supported when each uses a separate volume.
- Agents and sessions share the daemon and use NMG ownership/scope boundaries;
  they do not start one daemon per session.

This is the reproducible NMG runtime base. It deliberately does not expose an
Agent Memory Leaderboard Add/Search endpoint yet. That adapter should connect
to this single daemon through the existing daemon client rather than opening a
second `NmgService` against the same SQLite database.

