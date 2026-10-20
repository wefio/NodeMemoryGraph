# NMG 规模与缓存突破评测

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

本评测在把存储从 100、1K、10K 增长到 100K 条记忆的同时，保持同样的八个可回答问题。
期望记忆在新近的干扰项之前插入，因此该测试刻意把冷证据推出既有的 500 行候选窗口。

运行：

```powershell
npm run eval:scale
```

快速运行用 `NMG_SCALE_SIZES=100,1000`，逐查询轨迹用 `NMG_SCALE_VERBOSE=1`。

报告的维度包括证据准确率、层级命中率、返回上下文大小、P50/P95 延迟、批量摄取吞吐
与 FTS 回填成本。检索基线是：

- `legacy`：最初的、有界热窗口混合打分器；
- `fts5`：SQLite 全文本检索；
- `hashing`：在有界窗口上的确定性哈希向量；
- `qwen3`：来自所配置 OpenAI 兼容端点的 Qwen3 向量；
- `hybrid`：FTS 候选加语义/热工作集。

启用 Qwen 时，矩阵单独记录向量构建时间。随后可用 `npm run index:ann` 构建持久化的
USearch HNSW 索引，以便把 ANN 召回与维护成本同实测暴力扫描相比。

首次缓存突破运行确立了 ANN 闸门：在 100 条记忆时 legacy 路径达到 100% 准确率、
P50 约 3 ms；在 100K 时它达到 37.5%、P50 约 568 ms。FTS5 保持在 75% 且低于 1 ms，
而 ANN 之前的 hybrid 恢复到 87.5%，但 P50 仍约 522 ms，因为图与语义路由仍在扫描
大规模候选集。这些数字是本地合成测量，不是通用 benchmark 主张。

合成工作负载是系统测试，不是对 LongMemEval 或 BEAM 的替代。它回答一个更窄的问题：
在浅层工作集被耗尽之后，一条相关记忆是否仍然可达？
