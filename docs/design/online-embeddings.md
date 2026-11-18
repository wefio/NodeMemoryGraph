# Online Embedding Providers

[English](online-embeddings.md) | [简体中文](online-embeddings.zh-CN.md) · [Terms](online-embeddings.terms.yaml)

NMG can keep its memory database and ANN index local while sending only the
text that needs embedding to a hosted provider. The Pi extension, index
commands, and benchmark bridge share one provider registry:

```text
src/core/embedding-providers/
├── cloudflare.ts
├── gemini.ts
├── jina.ts
├── openai.ts
└── types.ts
```

Set `NMG_EMBED_PROVIDER` to enable a provider. After changing provider, model,
dimensions, or preprocessing, run `npm run index:embeddings`; the resulting
index identity prevents vectors from incompatible configurations being mixed.
Pi continues to use FTS5 until the selected record index is ready and falls
back to FTS5 when an online request fails.

Free allocations and rate limits are provider policies, not NMG guarantees.
They can change, and free-tier inputs may be used to improve provider products.
Do not send sensitive memories unless the provider's data policy is acceptable.

## Cloudflare Workers AI

The default is the multilingual `@cf/baai/bge-m3` model through Cloudflare's
OpenAI-compatible endpoint.

```powershell
$env:NMG_EMBED_PROVIDER = "cloudflare"
$env:CLOUDFLARE_ACCOUNT_ID = "..."
$env:CLOUDFLARE_API_TOKEN = "..."
npm run index:embeddings
```

`NMG_CLOUDFLARE_ACCOUNT_ID` and `NMG_EMBED_API_KEY` are equivalent NMG-specific
credential names. Override `NMG_EMBED_MODEL` to select another Workers AI
embedding model.

## Google Gemini

The default is `gemini-embedding-001`. NMG uses `batchEmbedContents` and sends
`RETRIEVAL_QUERY` for recall queries and `RETRIEVAL_DOCUMENT` for stored
memories.

```powershell
$env:NMG_EMBED_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "..."
npm run index:embeddings
```

Set `NMG_EMBED_DIMENSIONS` when a smaller output vector is desired.

## Jina AI

The default is `jina-embeddings-v3` through its OpenAI-compatible endpoint.

```powershell
$env:NMG_EMBED_PROVIDER = "jina"
$env:JINA_API_KEY = "..."
npm run index:embeddings
```

## Generic OpenAI-compatible endpoint

Arbitrary OpenAI-compatible embedding services remain available:

```powershell
$env:NMG_EMBED_PROVIDER = "openai"
$env:NMG_EMBED_BASE_URL = "http://127.0.0.1:8000/v1"
$env:NMG_EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
$env:NMG_EMBED_PROFILE = "qwen3"
npm run index:embeddings
```

For backward compatibility, setting `NMG_EMBED_BASE_URL` without
`NMG_EMBED_PROVIDER` selects `openai`.

## Shared options

| Variable               | Meaning                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `NMG_EMBED_API_KEY`    | Provider-neutral credential override                                        |
| `NMG_EMBED_MODEL`      | Provider model override                                                     |
| `NMG_EMBED_DIMENSIONS` | Requested output dimensions when supported                                  |
| `NMG_EMBED_BATCH_SIZE` | Maximum inputs per OpenAI-compatible HTTP request                             |
| `NMG_EMBED_CHUNK_CONCURRENCY` | Concurrent requests per configured provider connection in one process (default 4) |
| `NMG_EMBED_TIMEOUT_MS` | Per-attempt timeout, including the transport queue                            |
| `NMG_EMBED_PROFILE`    | `plain`, `bge-en`, or `qwen3` preprocessing for OpenAI-compatible providers |
| `NMG_EMBED_TARGETS`    | `records` by default; optional `nodes,leaves,records`                       |

API keys are read from the environment, never stored in benchmark parameter
snapshots, index IDs, or the memory database.

Local search embeds distinct query texts in provider-sized batches. Query and
document traffic share the concurrency limit. A provider that allows concurrent
requests has one slot reserved for queries. HTTP 429 applies the provider's
`Retry-After` to both kinds of work in the same process. A recall deadline or a
disconnected search cancels queued work, HTTP reads and retries. Providers
return vectors as JSON arrays.

## Core embedding interface

Core's [`VectorEmbedder`](../../src/core/types.ts) is a synchronous text-to-vector
interface with `dimensions`, `model` and `embed(text): readonly number[]`.
The interface alone does not select a hosted provider or establish compatibility
between embedding spaces.
