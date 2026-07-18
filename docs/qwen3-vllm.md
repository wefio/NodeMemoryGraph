# Qwen3 embedding through vLLM

NMG treats embeddings as an optional service. The default endpoint is the
OpenAI-compatible `http://127.0.0.1:8000/v1/embeddings`; SQLite, FTS5, and the
hashing fallback continue to work when the service is offline.

The selected model is `Qwen/Qwen3-Embedding-0.6B`: 0.6B parameters, up to 1024
dimensions, multilingual, and a 32K context window. Query strings receive an
instruction while stored documents do not, following the model's retrieval
usage contract.

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

The tested RTX 3060 Laptop GPU has 6 GB VRAM. The model's default 32K context
could not reserve enough KV cache; 8K is sufficient for NMG node and leaf headers
and started successfully under Ubuntu 26.04 WSL.

## Build or resume the index

From Windows PowerShell:

```powershell
$env:NMG_EMBED_BASE_URL = "http://127.0.0.1:8000/v1"
$env:NMG_EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
$env:NMG_EMBED_BATCH_SIZE = "64"
npm run index:qwen3
```

By default this embeds only the progressive-disclosure index: node headers and
leaf/block headers. To compare against full per-record vectorization:

```powershell
$env:NMG_EMBED_TARGETS = "nodes,leaves,records"
npm run index:qwen3
```

ANN is built per index granularity. Leaf blocks are the default:

```powershell
$env:NMG_ANN_TARGET = "leaves" # or "nodes" / "records"
$env:NMG_ANN_PATH = ".nmg/indexes/qwen3-leaves.usearch"
npm run index:ann
```

The command only requests memories missing that model's vector, commits each
batch transactionally, and can be restarted. Hashing and Qwen3 vectors coexist
under `(memory_id, model)`.

To include Qwen3 in the scale matrix, leave the same environment variables set
and run `npm run eval:scale`. Without an endpoint, the evaluation still runs the
legacy, FTS5, hashing, and hashing-hybrid controls.
