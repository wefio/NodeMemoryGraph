# 在线 Embedding Provider

[English](online-embeddings.md) | [简体中文](online-embeddings.zh-CN.md) · [术语](online-embeddings.terms.yaml)

NMG 可将 memory database 与 ANN index 保留在本地，只把需要生成 embedding 的文本发送给托管 provider。Pi extension、索引命令与 benchmark bridge 共用 provider registry：

```text
src/core/embedding-providers/
├── cloudflare.ts
├── gemini.ts
├── jina.ts
├── openai.ts
└── types.ts
```

设置 `NMG_EMBED_PROVIDER` 以启用 provider。更改 provider、model、dimensions 或 preprocessing 后，运行 `npm run index:embeddings`；生成的 index identity 会阻止混用不兼容配置的向量。所选 record index 尚未就绪时，Pi 继续使用 FTS5；在线请求失败时也回退到 FTS5。

免费额度与速率限制由 provider 决定，不是 NMG 保证；政策可能变化，免费层输入也可能被用于改进 provider 产品。除非 provider 的数据政策可接受，否则不要发送敏感记忆。

## Cloudflare Workers AI

默认使用 Cloudflare OpenAI-compatible endpoint 上的多语言模型 `@cf/baai/bge-m3`。

```powershell
$env:NMG_EMBED_PROVIDER = "cloudflare"
$env:CLOUDFLARE_ACCOUNT_ID = "..."
$env:CLOUDFLARE_API_TOKEN = "..."
npm run index:embeddings
```

`NMG_CLOUDFLARE_ACCOUNT_ID` 与 `NMG_EMBED_API_KEY` 是 NMG 专用的等价 credential 名称。可用 `NMG_EMBED_MODEL` 覆盖 Workers AI embedding model。

## Google Gemini

默认使用 `gemini-embedding-001`。NMG 调用 `batchEmbedContents`，为 recall query 发送 `RETRIEVAL_QUERY`，为存储的 memory 发送 `RETRIEVAL_DOCUMENT`。

```powershell
$env:NMG_EMBED_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "..."
npm run index:embeddings
```

支持时，可通过 `NMG_EMBED_DIMENSIONS` 请求较小的输出向量。

## Jina AI

默认通过 OpenAI-compatible endpoint 使用 `jina-embeddings-v3`。

```powershell
$env:NMG_EMBED_PROVIDER = "jina"
$env:JINA_API_KEY = "..."
npm run index:embeddings
```

## 通用 OpenAI-compatible endpoint

也可使用任意 OpenAI-compatible embedding service：

```powershell
$env:NMG_EMBED_PROVIDER = "openai"
$env:NMG_EMBED_BASE_URL = "http://127.0.0.1:8000/v1"
$env:NMG_EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
$env:NMG_EMBED_PROFILE = "qwen3"
npm run index:embeddings
```

为兼容旧配置，若设置 `NMG_EMBED_BASE_URL` 而未设置 `NMG_EMBED_PROVIDER`，会选择 `openai`。

## 共享选项

| 变量 | 含义 |
|---|---|
| `NMG_EMBED_API_KEY` | provider-neutral credential override |
| `NMG_EMBED_MODEL` | provider model override |
| `NMG_EMBED_DIMENSIONS` | provider 支持时请求的输出维度 |
| `NMG_EMBED_BATCH_SIZE` | 增量索引批次大小 |
| `NMG_EMBED_TIMEOUT_MS` | 每次请求的超时 |
| `NMG_EMBED_PROFILE` | OpenAI-compatible provider 的 `plain`、`bge-en` 或 `qwen3` preprocessing |
| `NMG_EMBED_TARGETS` | 默认 `records`；可选 `nodes,leaves,records` |

API key 只从环境变量读取，不写入 benchmark 参数快照、index ID 或 memory database。

## Core 嵌入接口

Core 的 [`VectorEmbedder`](../../src/core/types.ts) 是同步文本到向量接口，包含 `dimensions`、`model` 和 `embed(text): readonly number[]`。该接口本身不选择托管 provider，也不证明不同 embedding 空间兼容。