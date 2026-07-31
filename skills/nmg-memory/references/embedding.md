# Semantic search and embeddings

NMG has two retrieval paths: **lexical** (FTS5, zero configuration) and
**semantic** (vectors, requires an embedding provider and a built index).
Both run inside one query when `--retrieval-mode hybrid` is used.

## 1. Configuration

Set these environment variables before starting the NMG daemon (or before a
one-shot `nmg` command):

| Variable | Purpose | Example |
| --- | --- | --- |
| `NMG_EMBED_PROVIDER` | Provider family | `openai`, `cloudflare`, `gemini`, `jina` |
| `NMG_EMBED_BASE_URL` | OpenAI-compatible endpoint | `http://localhost:8000/v1` |
| `NMG_EMBED_API_KEY` | API key | `sk-...` |
| `NMG_EMBED_MODEL` | Model name | `qwen3-emb`, `text-embedding-3-small` |
| `NMG_EMBED_PROFILE` | Profile template | `qwen3`, `bge-en`, `plain` |
| `NMG_EMBED_QUERY_TEMPLATE` | Query template (must contain `{text}`) | `Instruct: {text}` |
| `NMG_EMBED_DOCUMENT_TEMPLATE` | Document template (must contain `{text}`) | `Passage: {text}` |
| `NMG_EMBED_DIMENSIONS` | Override vector dimensions | `1024`, `768` |
| `NMG_EMBED_TIMEOUT_MS` | Request timeout (default 10 s) | `5000` |

Provider fallbacks: `NMG_EMBED_API_KEY` falls back to the provider's own
variable (`GEMINI_API_KEY`, `JINA_API_KEY`, `CLOUDFLARE_API_TOKEN`).

## 2. Building the index

```text
npm run index:embeddings   # batch-build the embedding index
npm run index:status       # inspect index health (targets, pending, last success)
```

`index:status` must show the store as ready before semantic retrieval will
engage. Without a built index, semantic search degrades to lexical (visible
in the result header's `retrieval` field: `degraded: true`).

## 3. Search modes

`nmg search --retrieval-mode <mode>`:

| Mode | Behavior |
| --- | --- |
| `fts5` | Lexical only (zero config, default) |
| `qwen3` | Vectors only (requires a built index) |
| `hybrid` | Lexical + vector fusion (recommended once indexed) |
| `hashing` | Deterministic hash baseline (evaluation only) |
| `legacy` | Legacy routing |

`--vector-granularity` controls which vectors are compared:

| Value | Behavior |
| --- | --- |
| `hierarchy` | Node + leaf-block compressed routing (default, fast) |
| `records` | Full record vectors (diagnostic path) |
| `union` | hierarchy + records in parallel, deduplicated merge |

## 4. Workflow rule

Semantic recall is an escalation step, not the first choice:

> If lexical results are insufficient and embeddings are configured and the
> index is ready, switch `--retrieval-mode hybrid`.

Check embedding health any time recall quality is in doubt:

```text
nmg status --json   # reports embedding provider, index health, and reason
```
