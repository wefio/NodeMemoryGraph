# 语义搜索与 Embedding

[English](embedding.md) · [术语](embedding.terms.yaml)

NMG 有两条检索路径：**词法检索**（FTS5，零配置）和**语义检索**（向量，需要 embedding provider 和已构建的索引）。使用 `--retrieval-mode hybrid` 时，两条路径在一次查询中共同运行。

## 1. 配置

在启动 NMG daemon（或执行一次性 `nmg` 命令）前设置以下环境变量：

| 变量 | 用途 | 示例 |
| --- | --- | --- |
| `NMG_EMBED_PROVIDER` | Provider 类型 | `openai`、`cloudflare`、`gemini`、`jina` |
| `NMG_EMBED_BASE_URL` | OpenAI 兼容端点 | `http://localhost:8000/v1` |
| `NMG_EMBED_API_KEY` | API key | `sk-...` |
| `NMG_EMBED_MODEL` | 模型名称 | `qwen3-emb`、`text-embedding-3-small` |
| `NMG_EMBED_PROFILE` | Profile 模板 | `qwen3`、`bge-en`、`plain` |
| `NMG_EMBED_QUERY_TEMPLATE` | 查询模板（必须包含 `{text}`） | `Instruct: {text}` |
| `NMG_EMBED_DOCUMENT_TEMPLATE` | 文档模板（必须包含 `{text}`） | `Passage: {text}` |
| `NMG_EMBED_DIMENSIONS` | 覆盖向量维度 | `1024`、`768` |
| `NMG_EMBED_TIMEOUT_MS` | 请求超时（默认 10 秒） | `5000` |

Provider key 的回退：`NMG_EMBED_API_KEY` 可回退到对应 provider 的环境变量（`GEMINI_API_KEY`、`JINA_API_KEY`、`CLOUDFLARE_API_TOKEN`）。

## 2. 构建索引

```text
npm run index:embeddings   # 批量构建 embedding 索引
npm run index:status       # 查看索引健康状态（目标、待处理项、最近成功时间）
```

只有当 `index:status` 显示 store 已就绪时，语义检索才会启用。没有已构建索引时，语义搜索会降级为词法检索（结果标题的 `retrieval` 字段会显示 `degraded: true`）。

## 3. 搜索模式

`nmg search --retrieval-mode <mode>`：

| 模式 | 行为 |
| --- | --- |
| `fts5` | 仅词法检索（零配置，默认） |
| `qwen3` | 仅向量检索（需要已构建索引） |
| `hybrid` | 词法与向量融合（建好索引后推荐） |
| `hashing` | 确定性哈希基线（仅用于评估） |
| `legacy` | 旧版路由 |

`--vector-granularity` 控制比较哪些向量：

| 值 | 行为 |
| --- | --- |
| `hierarchy` | 节点与 leaf-block 压缩路由（默认、快速） |
| `records` | 完整记录向量（诊断路径） |
| `union` | 并行使用 hierarchy 和 records，并去重合并 |

## 4. 工作流规则

语义召回是升级步骤，不是首选：

> 如果词法结果不足、embedding 已配置且索引就绪，则切换到 `--retrieval-mode hybrid`。

对召回质量有疑问时，检查 embedding 健康状态：

```text
nmg status --json   # 报告 embedding provider、索引健康状态及原因
```
