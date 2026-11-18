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
| `NMG_EMBED_BATCH_SIZE` | OpenAI 兼容接口每个 HTTP 请求最多接收的文本数 |
| `NMG_EMBED_CHUNK_CONCURRENCY` | 单个进程对同一服务商连接配置的请求并发上限，默认 4 |
| `NMG_EMBED_TIMEOUT_MS` | 每次尝试的超时，包含等候 HTTP 请求名额的时间 |
| `NMG_EMBED_PROFILE` | OpenAI-compatible provider 的 `plain`、`bge-en` 或 `qwen3` preprocessing |
| `NMG_EMBED_TARGETS` | 默认 `records`；可选 `nodes,leaves,records` |

API key 只从环境变量读取，不写入 benchmark 参数快照、index ID 或 memory database。

本地检索对查询文本去重，按服务商允许的大小合批。查询和文档共用并发上限，上限大于 1 时给查询预留一个名额。收到 HTTP 429 后，同一进程的两类请求都遵守服务商的 `Retry-After`。自动召回超时或搜索连接断开时会取消排队、HTTP 读取和重试。

## 本地响应格式协商

本地 daemon 按端点、API 模型和用途分别记录查询与文档的格式。记录键也区分 embedding 配置和凭据身份。记录位于 `<data-dir>/embedding-formats/`，每份 JSON 包含端点的 origin、模型、用途、格式、原因和检查时间。文件中没有密钥、输入文本或向量。

对于 OpenAI 兼容端点，首次符合条件的请求可以尝试 `encoding_format: "base64"`。daemon 检查响应顺序、维度和 Float32 值是否有限，再用同一个请求取得 JSON 数字数组做对照。文档向量须与 JSON 写入 SQLite 时的 Float32 值一致，查询向量须与评分用的数字值一致。自动召回使用已有记录，跳过新的探测。

端点明确拒绝格式选项时，回退请求一次数字数组。回退成功、端点直接返回数字数组、或两种格式的向量值不一致时，记录使用 JSON。限速、超时、取消和其他传输故障保留原判定。记录七天后过期，后续使用时可以重新协商。

Gemini 原生适配器继续用 `batchEmbedContents` 分别请求查询和文档，成功后记录原生 JSON。格式判定独立于现有向量索引的标识和数据。确认兼容的 Base64 文档响应可以解码成 Float32 字节，直接交给 SQLite 写入。

## Core 嵌入接口

Core 的 [`VectorEmbedder`](../../src/core/types.ts) 是同步文本到向量接口，包含 `dimensions`、`model` 和 `embed(text): readonly number[]`。该接口本身不选择托管 provider，也不证明不同 embedding 空间兼容。
