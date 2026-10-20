# Hybrid 正确性与上下文级评分——2026-10-10

[English](hybrid-context-scoring-2026-10-10.md) · [术语](hybrid-context-scoring-2026-10-10.terms.yaml)

## 先正确，再计时

基线 `ee32e448b2d978174754ab5d97c47bf0a0d72588` 存在 temporary TODO 第 8 项记录的
hybrid 位置绑定缺陷。用八个 tier-2 FTS 命中构成有界 fixture；修复前六个正例失败：
无过滤、各自时间边界、双时间边界、多键 scope、时间与 scope 联合。有些返回空；
一次受控的仅时间窗口运行在五条合格时返回七条。这不能估计生产出现频率或总体召回损失。

修复只把重复的 `ORDER BY` ID 绑定移至全部 `WHERE` 参数之后。
九项[绑定契约](../../../tests/core/store/hybrid-bindings.test.ts)覆盖正确 ID、含端点边界、
缺日期／scope 键、拒绝记录、重复顺序稳定性、FTS-only／vector-only／forced／no-hit
对照，以及公共 second-pass context。连同既有检索／评分测试，57/57 通过。
context fixture 显式请求 QPP 扩展：最初假定最大 limit 必须返回更多记录，但 QPP
合法地在充分时停止，只返回一个合格命中；调试器确认后，用 `qppThreshold: 1`
请求预期的双记录扩展，不改变产品行为。

## 方法

[原始工件](hybrid-context-scoring-2026-10-10.json)保留样本、parity hash、
源码／存储 hash 与环境。Windows x64、Node v24.19.0、native SQLite 3.53.3、
Intel i7-12700H；没有 live embedding／LLM／provider 调用。

私有语料有 300 个 memory／history、八个 node，全部 memory 为 tier 2。
statement 为 `scoring corpus entry {i}`，node 为 `Corpus node {i%8}`。
dense 向量为 1,024 维，值为 `Math.sin((i+1)*(j+1))*0.03 + 0.03`。
正偏置保证兜底结果非空；最初零中心 probe 对一些过滤查询正确拒答，未被接受为计时结果。
这是合成几何，不是缓存 Qwen embedding。
`i%4==0` 的 project 为 `Other`，其余为 `Atlas`，tenant 为 `north`。
`i%10==0` 无时间，`i%10==1` 为 `2026-10-04`，其余偶数为 10 月 5 日、奇数为 6 日；
过滤保留 180 条。查询向量为语料向量 q，q=0..31；0..15 查询 `scoring corpus`
（300 个 FTS 命中），16..31 查询 `unmatchedsemanticprobe`（零命中）。
两组均使用 scope 合取与含端点的 10 月 5–6 日窗口。

计时 API 是完整同步 `store.searchContext(query, options)`：缓存 embedder 调用、
SQL／FTS 与候选读取、时间／scope 过滤、解码／评分／映射、node routing、排名、
AG 预算／投影、QPP 扩展和 chain lookup。参数为 limit 10、`secondPass: true`、
`initialEvidenceTarget: 1`、`qppThreshold: 1`、`expandChains: true`；
每个样本均有合格正证据和至少两个 QPP 阶段。没有注入 chain；
此路径不调用层级语义 node／leaf routing。

三轮配对按 decoded→borrowed、borrowed→decoded、decoded→borrowed 交替。
每个 reader 使用新 Node 进程与同一关闭 fixture DB 的只读字节副本，
先运行一轮 32 查询预热，再测两轮：每 reader 192 个样本，每 FTS 条件 96 个。
store 打开、向量生成、模块加载、子进程启动、FTS 前提断言、输出／parity hash 与数据
fingerprint 均不计时。Date.now 固定在 `2026-10-10T08:00:00Z`，
performance.now 保持单调；`persistTrace: false` 排除 trace／学习写入。

borrowed 模式运行未改动的已修复模块；decoded 模式仅在即时 cosine 调用处，严格作一次
内存 Node 模块加载替换：`scoringVector(row, "ve_")` →
`storedVector(row, "ve_")`。不复制 BLOB 到未对齐 buffer，也不改写源码或数据库。
脚本断言恰有一次替换，复用 mean／median／nearest-rank percentile 部件，
拒绝空／缺失输入和任何失败子进程，使用后删除。

## 结果

| 上下文路径 | Decoded 中位数 | Borrowed 中位数 | Decoded P95 | Borrowed P95 |
| --- | ---: | ---: | ---: | ---: |
| 全部查询（各 192） | 10.3724 ms | 7.1587 ms | 15.1341 ms | 11.5715 ms |
| 正 FTS（各 96） | 10.8198 ms | 7.9370 ms | 16.3959 ms | 12.0945 ms |
| 无命中兜底（各 96） | 9.6909 ms | 6.5602 ms | 12.7449 ms | 9.2450 ms |

合并样本中位数降低 31.0%，正 FTS 中位数降低 26.6%。192 对结果投影的 memory
ID／顺序、完整分数字段、selections、QPP 决策及非计时 AG usage 全部一致。
六个进程的存储 fingerprint 前后一致；工件保留实际源码 SHA，probe 后源码未改。

## 边界

两 reader 都执行修正 SQL；不是把错误空路径与有效结果计时对比，也不把恢复正确性当加速。
不推断生产影响、真实 LoCoMo／Qwen 复现、层级语义 benchmark、trace 写入成本、
RPC／harness／网络延迟、云／WASM／VFS 结果、CPU profile 或普遍收益。
三对工作站配对是测量观察，不是最坏情况保证。真实 LoCoMo／Qwen 重放仍需缓存向量与
原 harness，只有数据集 URL 不够。
