# Float32 评分内核观测——2026-10-09

[English](float32-scoring-2026-10-09.md) · [术语](float32-scoring-2026-10-09.terms.yaml)

测量时间为 `2026-10-09T14:09:25.937Z`，比较未改动的 decoder 与基于
`7c18f6f61b375a129fc04ad6ba5ee62ebb0522ab` 的工作树评分 view。
[原始 JSON](float32-scoring-2026-10-09.json)保留样本与配置。

## Fixture 与方法

- Windows x64、Intel Core i7-12700H、Node v24.19.0、native SQLite 3.53.3。
- 私有内存 SQLite 表包含 300 个 BLOB 向量，每个为 1024D Float32；值为
  `Math.sin((i + 1) * (j + 1)) * 0.03`。
- 32 个普通数组查询向量使用同一公式，查询序号为 `i`。计时前加载全部 BLOB，
  每个样本为对 300 条记录评分的一次扫描。
- 两个实现按 round＋query 奇偶交替先后；排除两轮预热，六轮测量各产生 192 个样本。
- 旧表达式为 `cosineSimilarity(query, storedVector(row, "ve_"))`；
  新表达式为 `cosineSimilarity(query, scoringVector(row, "ve_"))`。
- 在计时区间外消费输出并核对 checksum；百分位使用 nearest rank：
  `ceil(n * 0.95) - 1`。
- 未调用 live provider、embedding、官方 benchmark、生产数据库或云工作负载；
  自有临时 probe 在测量后删除。

## 观测结果

| 内核指标 | 解码为普通数组 | 借用 Float32 view |
| --- | ---: | ---: |
| 扫描中位数 | 3.3905 ms | 0.3857 ms |
| 扫描 P95 | 3.7301 ms | 0.4739 ms |
| 采样进程 CPU 均值 | 3.5104 ms | 0.2344 ms |

进程 CPU 样本有许多零值和粗粒度阶跃；保留原始值，但不能从这个 Windows 计数器
推断细粒度的逐查询 CPU 节省。

计时前的 9,600 个记录分数用 `Object.is` 比较完全一致；全部预热及测量样本的累计
分数也一致（`249.34857042008198`）。300 个 native BLOB 行均可借用。
payload SHA-256 始终为
`66fea4328026b961de6ffafd7255c6f3b05cf90f697643b9e9f8ca619583de3e`。
契约测试另外把 store 结果顺序、完整分数、不修改输入和普通数组导出，与强制 decoder
兜底作比较。

## 限制

这是**合成评分内核**，不是端到端检索。SQL、NMG 过滤／排名、层级、second pass、
chain expansion、RPC、embedding 工作、Sites、SQLite WASM／VFS 和部署均不在计时内。
不能把内核比值换算为检索或云端加速。

用户报告的 LoCoMo conv-30／cached Qwen 实验（每个实现 162 个查询，中位数
21.83→12.99 ms，P95 42.38→25.35 ms）仍单独归因，未在此复现；原 harness 和缓存向量
工件不可用。基础 WASM 内存生命周期测试不证明 SQLite WASM 或 Sites 兼容性；
未验证 big-endian 硬件。
