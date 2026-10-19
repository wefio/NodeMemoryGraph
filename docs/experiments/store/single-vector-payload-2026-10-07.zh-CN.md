# 单一向量 payload 存储 probe

[English](single-vector-payload-2026-10-07.md) · [术语](single-vector-payload-2026-10-07.terms.yaml)

## 范围

这是[单一 payload 决策](../../decisions/implemented/2026-10-07-single-vector-payload.zh-CN.md)
的本地合成证据。[原始测量](single-vector-payload-2026-10-07.json)采于
2026-10-07T11:59:06.590Z，Node 24.19.0／SQLite 3.53.3。存储变更基于 main
`77f76446`；实现与本报告在同一提交。

输入是隔离的内存 NMG 图，不是所报告的云数据库。不调用 provider、live embedding model、
生产库或官方 benchmark。各阶段页大小均为 4,096 字节；下表是已分配 SQLite 页字节，
不是实测磁盘文件或 WASM／VFS 大小。

## 方法

1. 新建 `NmgStore(":memory:")`，用本地 256D hashing embedder，在 `synthetic` node
   记忆 300 条 statement。i=0..299，使用
   ``Synthetic storage probe ${i}: ${"retained source text ".repeat(24)}``。
2. 每条 memory 加一个 1024D `synthetic-dense` record embedding；
   元素 j 为 `Math.sin((i + 1) * (j + 1)) * 0.03`。总计 600 条 embedding，
   没有 node／leaf embedding。把每个解码 BLOB 用
   `JSON.stringify(storedVector(row))` 镜像进 `vector_json`，再对私有库 `VACUUM`。
   这是受控双格式基线，不是复原某 provider 原始 JSON 序列化。
3. 保存 vector／key／model／dimension／timestamp fingerprint，以及
   `searchByVector("storage probe", dense[0].vector, "synthetic-dense", { retrievalMode: "qwen3", maxTier: 3 })`
   返回的 ID 与向量分数。
4. 仅删除 fixture 的 `vector_storage_format` 完成标记，运行 `ensureBinaryVectors`，
   立即测量并重复 fingerprint／查询，再在独立的仅 fixture `VACUUM` 后测量。
5. 要求 300 条 history 与 memory、600 条 embedding，二进制字节和 embedding 元数据不变，
   ID／向量分数不变，integrity 为 `ok` 且无外键违规。缺失或非有限测量使 probe 失败。
   随机稳定 ID 跨运行会变化；每次 fingerprint 比较都在同一个库内。

## 结果

| 测量 | 已压缩双格式基线 | 迁移、未压缩 | 迁移＋压缩 |
| --- | ---: | ---: | ---: |
| JSON 向量字节 | 6,863,550 | 1,200 | 1,200 |
| BLOB 向量字节 | 1,536,000 | 1,536,000 | 1,536,000 |
| 已分配页 | 2,845 | 2,846 | 1,033 |
| 空闲页 | 0 | 1,501 | 0 |
| 已分配页字节 | 11,653,120 | 11,657,216 | 4,231,168 |

全部必需断言通过。在该 dense-vector fixture 中移除重复 JSON，释放约 6.54 MiB
逻辑 payload；比较两个已压缩端点，已分配页字节约少 63.7%。比例依赖这个合成 JSON
表示，不是云估计；迁移本身不会缩小已分配页。

## 限制

这是存储测量与窄检索身份检查，不是延迟或召回质量 benchmark。不验证云上传成本、
真实 Qwen 分布、冷缓存、Sites／WASM／VFS、备份恢复、多进程升级或其他页大小。
生产迁移不自动压缩数据库；node／leaf 持久化与回滚契约由产品存储测试分别覆盖。
