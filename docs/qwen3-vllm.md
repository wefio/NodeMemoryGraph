# External embeddings through vLLM

NMG treats embeddings as an optional provider, not as part of the memory
architecture. The default endpoint is the OpenAI-compatible
`http://127.0.0.1:8000/v1/embeddings`. Normal Pi retrieval always preserves the
same Active Graph budget and trace. If the provider fails or exceeds
`NMG_EMBED_TIMEOUT_MS`, the request explicitly degrades to SQLite FTS5. Hashing
remains an evaluation baseline rather than a production fallback.

The selected model is `Qwen/Qwen3-Embedding-0.6B`: 0.6B parameters, up to 1024
dimensions, multilingual, and a 32K context window. Query strings receive an
instruction while stored documents do not, following the model's retrieval
usage contract.

For the English benchmark development loop, the smaller
`BAAI/bge-small-en-v1.5` (384 dimensions) is a useful low-cost control. Select
the explicit `bge-en` profile to apply its retrieval query prefix while leaving
stored node and leaf documents unprefixed. Qwen3 remains the better default
candidate when one model must cover both Chinese and English.

## WSL service

Install an Ubuntu WSL distribution and a CUDA-compatible vLLM environment,
then start the pooling server inside WSL:

```bash
vllm serve Qwen/Qwen3-Embedding-0.6B \
  --runner pooling \
  --dtype half \
  --host 0.0.0.0 \
  --port 8000 \
  --gpu-memory-utilization 0.80 \
  --max-model-len 8192
```

Small English BGE alternative:

```bash
vllm serve BAAI/bge-small-en-v1.5 \
  --runner pooling \
  --dtype half \
  --host 0.0.0.0 \
  --port 8000
```

The tested RTX 3060 Laptop GPU has 6 GB VRAM. The model's default 32K context
could not reserve enough KV cache; 8K is sufficient for NMG node and leaf headers
and started successfully under Ubuntu 26.04 WSL.

## Build or resume the index

From Windows PowerShell:

```powershell
$env:NMG_EMBED_BASE_URL = "http://127.0.0.1:8000/v1"
$env:NMG_EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
$env:NMG_EMBED_PROFILE = "qwen3"
$env:NMG_EMBED_BATCH_SIZE = "64"
$env:NMG_EMBED_TIMEOUT_MS = "10000"
npm run index:qwen3
```

`npm run index:embeddings` is the model-neutral alias. For BGE set both
`NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5` and `NMG_EMBED_PROFILE=bge-en` before
running it. Model names never select preprocessing implicitly. The `plain`
profile applies no query prefix. Custom profiles can be expressed with
`NMG_EMBED_QUERY_TEMPLATE` and `NMG_EMBED_DOCUMENT_TEMPLATE`; both must contain
`{text}`.

By default this embeds records, which is the retrieval path used by the Pi
extension. To additionally build the experimental progressive-disclosure
indexes:

```powershell
$env:NMG_EMBED_TARGETS = "nodes,leaves,records"
npm run index:qwen3
```

This default follows a matched LoCoMo ablation with
`BAAI/bge-small-en-v1.5` measured 18.0% exact evidence recall for node/leaf
summaries versus 52.9% for record vectors and 45.1% for FTS5. Until a better
coarse-to-fine ranker is demonstrated, production recall should keep FTS5 or
record vectors in the evidence stage; node/leaf vectors are a directory and
large-scale routing optimization only. Both the Pi extension and benchmark
bridge therefore default to record granularity whenever an embedding provider
is enabled. An existing node/leaf-only index is rejected for that path and Pi
falls back to FTS5 until record vectors are indexed.

ANN is built per index granularity. Leaf blocks are the default:

```powershell
$env:NMG_ANN_TARGET = "leaves" # or "nodes" / "records"
$env:NMG_ANN_PATH = ".nmg/indexes/qwen3-leaves.usearch"
npm run index:ann
```

The command requests only missing or stale vectors, commits each batch
transactionally, and can be restarted. The persisted index identity includes
the server model and query/document preprocessing contract, so changing the
profile, templates, or dimensions cannot silently reuse incompatible vectors.
SQLite missing/stale queries act as the durable work queue. The command reports
pending and indexed counts plus the last success or retryable failure.
Use `npm run index:status` with the same profile variables to inspect the
persisted state without starting vLLM or contacting another provider.

To include Qwen3 in the scale matrix, leave the same environment variables set
and run `npm run eval:scale`. Without an endpoint, the evaluation still runs the
legacy, FTS5, hashing, and hashing-hybrid controls.
