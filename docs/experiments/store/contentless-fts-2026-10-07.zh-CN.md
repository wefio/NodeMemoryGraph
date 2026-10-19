# 无内容词法 FTS：有界本地存储 probe

[English](contentless-fts-2026-10-07.md) · [术语](contentless-fts-2026-10-07.terms.yaml)

## 范围与设置

测量于 **2026-10-07T13:12:49.636Z**，Node **v24.19.0**、SQLite **3.53.3**，
页大小 4096 字节。[原始结果](contentless-fts-2026-10-07.json)。

私有内存图有 300 条合成 memory 和 300 条 history，仅用默认本地 hashing embedding；
node／leaf embedding 表为空。未使用云数据库、provider、live session 或生产文件。
每条 statement 为：

```text
Storage corpus item {index}. 用户希望保留中文解释与原始证据。 C++ v2.4.1
+ 'retained source text '.repeat(24)
```

node 名为 `FTS corpus`，每条记录有独立 fixture item scope，并把 `fixture-alias`
索引为 recall trigger。此 fixture 中 history 与 statement 字节恰好相同，但两个权威
字段均保留。

基线把当前变换后的文档镜像到旧全文 FTS5 schema，保持 lexical rowid。
向量存储已经是单一 payload；先压缩基线，再让同库执行正常 FTS 迁移，
最后**单独在 fixture 上运行 `VACUUM`**以测端点分配。临时 probe 使用
`--rows 300 --out <raw-result-path>`，断言非空数据及每项保留性质，运行后删除。

## 观测

| 测量 | 已压缩全文基线 | 无内容、未压缩 | 无内容＋仅 fixture 压缩 |
|---|---:|---:|---:|
| Memory／history 行数（各） | 300 | 300 | 300 |
| Lexical／surface FTS 行数（各） | 300 | 300 | 300 |
| 原 history UTF-8 字节 | 176,290 | 176,290 | 176,290 |
| Statement UTF-8 字节 | 176,290 | 176,290 | 176,290 |
| 重复 FTS 全文 UTF-8 字节 | 418,580 | 0 | 0 |
| 页数 | 774 | 774 | 619 |
| 空闲页 | 0 | 154 | 0 |
| 已分配字节 | 3,170,304 | 3,170,304 | 2,535,424 |

FTS 文本字节计入已变换 statement、node-name、evidence，不含旧未索引 memory-ID 列与页
开销；包含 Han bigram 与 trigger 文本，不能直接算作输入字节的两倍。

断言全部通过：完整 history／memory／node 行 fingerprint 不变；三个 embedding 表的
fingerprint 均不变（node／leaf 为空）；正英文、Han-bigram 与 trigger 查询的 ID、
lexical rowid、BM25 分数相同；标点 surface 查询 ID 相同；行数保留；integrity 为
`ok`；无外键违规。

## 解释与限制

移除约 **408.8 KiB** 逻辑重复全文。迁移释放页，但**没有**缩小已分配空间。
压缩端点在该 fixture 中减少 **634,880 字节（620 KiB，约 20.0%）**。
两者都不是云节省或延迟测量，页布局、语料与 embedding 会改变结果。

probe 不证明这些查询之外的召回质量、云兼容、SQLite WASM／VFS、备份恢复或崩溃时
多进程升级。未做生产压缩或页大小迁移。旧 FTS SQL 消费方使用迁移后的数据库前必须采用
registry 映射；仅能读取二进制向量并不提供这项兼容性。
