# 仅在同步打分期间借用 Float32 向量

[English](2026-10-09-borrow-float32-scoring.md)

**Status:** implemented
**Approved:** auto
**Relates to:** [单份向量载荷](2026-10-07-single-vector-payload.zh-CN.md)

## Problem

`searchWithVector` 在计算余弦前，将每份首选 BLOB 解码为普通 JavaScript
数组，而其中已经保存了相同的 Float32 数值。用户提供的单段对话对照建议
消除这次分配；其约 40% 的端到端提升尚未在此独立复现。

## Decision

新增内部 `scoringVector`，仅在记录向量的同步余弦表达式中使用。
只有小端主机上的投影值为 `Uint8Array`、偏移与长度均为四字节整数倍、
底层为私有且不可调整大小的 `ArrayBuffer` 时，才借用 `Float32Array`。
视图严格限定于当前切片，不读取整个底层分配。

其余情况调用未改动的 `storedVector`：投影 NULL/错误类型仍具有原优先级，
兼容旧 JSON 和独立 BLOB/JSON 列，不完整浮点载荷保留原有截断行为。
不新增存储标记、迁移、精度变化、环境选项或公共返回类型。
公共向量读取器和缓存保持原有普通数组行为。

视图的只读性由调用方式约束，JavaScript 并未冻结它。
不得缓存、向消费者返回，或跨越异步工作/WASM 堆增长保留它。
共享或可调整大小的缓冲区不使用快路径，避免扩大可变内存的借用寿命。

## Alternatives considered

- 每次继续分配普通数组：正确，但完整、对齐且立即使用的载荷无需此复制。
- 公共读取 API 返回视图：会改变所有权、可变性和寿命预期，不采用。
- 接受共享/可调整缓冲区，或在快路径忽略尾部字节：不重新定义旧语义，保留解码回退。
- 修改候选选择、预归一化或缓存所有解码向量：属于成本与有效性约束不同的独立决策。

## Consequences

八项安全/契约回归覆盖切片所有权、对齐、残缺载荷、优先级与回退、不改动
原始字节、Float32 特殊值、原生 SQLite 语句复用/删行/关闭、基本 WASM
堆增长、公共数组，以及相对解码回退的结果和分数精确一致。
Store 对照要求 qwen3/hashing 与 hybrid 无 FTS 命中回退均有正结果；
既有 hybrid FTS 命中的参数顺序缺陷记录于
[待办](../../design/temporary-todo.md#8-repair-hybrid-fts-hit-sql-parameter-ordering)，
本轮不修复，也不把空结果一致视为有效排序证明。

[离线观察](../../experiments/retrieval/float32-scoring-2026-10-09.md)只计时合成
向量的打分内核，支持避免解码复制，并非通用检索或云端提速承诺。

## Deferred

取得用户的计时脚本和缓存向量，复现 LoCoMo/Qwen 对照。
实际 Sites/SQLite WASM/VFS、部署内存所有权仍需验证；基本
`WebAssembly.Memory` 测试不等于该集成验收。未运行大端硬件，但其走
原解码分支。本轮未运行生产基准、在线模型调用或云端部署。
