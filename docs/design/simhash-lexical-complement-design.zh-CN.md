# 用于 supersession 候选的 SimHash 词法补充

[English](simhash-lexical-complement-design.md) | [简体中文](simhash-lexical-complement-design.zh-CN.md) · [术语](simhash-lexical-complement-design.terms.yaml)

**Status:** draft

草案提案；尚未用于 memory supersession 候选召回。仓库已有共享 SimHash 工具，但当前调用方将其用于 tessera 文件漂移恢复，而非 `memory_records` 或 `supersedeCandidates`。

来源：2026-09-03 的工单 7 草案。本提案补充当前[取代设计](supersession-design.md)，不改变其语义判断边界。

## 1. 问题

当前 `supersedeCandidates` 路径使用同 scope token 预过滤、归一化 token 重叠、转换短语、调用方提供的 polarity 和 `statementSimilarity`。Memory 写入 token 路径会转小写、移除非 ASCII 字符，并只保留至少两个字符的 token；它不执行词干化或拼写归一化。例如：

| 已有陈述 | 新写入陈述 | 当前候选路径的问题 |
| --- | --- | --- |
| `解释: explanations` | `解释: explanation` | 新写入的单数 token 可能通过子串预过滤，但精确 token 重叠仍为零。 |
| `embeddings 配置` | `embedding 配置` | Han 文本会从此写入 token 集中移除；剩余英文单复数形式不同。 |
| `colour` | `color` | 没有共享 token 子串，当前预过滤可能完全漏掉旧记录。 |

这些例子用于说明可能的召回缺口，不是测得的漏召率。对于没有已识别转换短语的纯 Han 新陈述，当前写入 token 路径不会返回 supersession 候选；仅提供 polarity 也无法绕过这个提前返回。当前实现与判断边界见[取代设计](supersession-design.md)。

## 2. 目标与边界

**目标：**评估一种确定性的词法指纹通道，让词形、拼写或文字系统变体能够进入候选集供调用方审阅。

**非目标：**

- 不从指纹推断语义身份、不合并记录，也不据此应用 supersession。调用方仍须判断记录是否描述同一作用域内的同一单值属性。
- 不更改检索排序，也不复用已被拒绝的 hashing-retrieval fallback。
- 不增加外部依赖，不把其他系统的阈值当成 NMG 结果。
- 不假设现有 tessera 指纹及阈值适用于 memory 陈述。

NMG 已有 `src/core/simhash.ts`，用于 tessera 文件漂移路径。这说明有可复用的实现原语，不代表它在 supersession 候选召回上的性能已经验证。Tessera 持久化的共享指纹使用 16 位小写十六进制文本；完整无符号 64-bit 范围不能作为 SQLite 有符号 `INTEGER` 持久化。

## 3. 候选提案

草案方案是对归一化词法 token 计算 64-bit token SimHash，并用 Hamming distance 作比较。此前提出的 `Hamming <= 3` 仅是实验起点，不是已验证阈值。

可行的召回通道必须独立于精确 token 预过滤，以覆盖 `colour`／`color` 这样的变体；若只对已由 `instr()` 选出的记录计算 Hamming distance，就无法找回已被预过滤排除的记录。单个指纹列本身也无法高效查询 Hamming 半径范围。因此存储编码、同 scope 候选查询、索引策略、迁移／回填和写入成本仍是待定设计问题。

任何实现都必须将新候选与现有列表合并去重，遵守相同 scope 和状态规则，保留 `SUPERSEDE_CANDIDATE_MAX` 上限，并让语义判断留给调用方。当前精确 token、transition 和 polarity 通道仍是基线。

## 4. 实现前所需证据

原工单要求先做本地对照，再决定是否实现。来源准确的实验应：

1. 使用声明明确、可复现的数据集，并报告大小、来源和 scope；不能假定旧估算值（如“约 330 条记忆”）代表当前数据库。
2. 从符合条件的陈述构造单 token 词形与拼写变体，冻结生成器，并分开 test／validation 样本。
3. 测量当前候选召回率、新通道召回率、误候选率及额外查询／写入成本；候选召回率必须与语义 supersession 准确率分开。
4. 纳入有代表性的短陈述、中文／混合文字文本，以及没有精确共享 token 的变体。
5. 判断新增召回是否值得相应存储和查询成本；否则保留当前路径并记录结果。

本草案不声称已获得这些实验结果。`src/core/simhash.ts` 单测与 tessera 漂移测试覆盖的是不同用途，不能验证 supersession 候选召回。

## 5. 开放问题

- 哪种指纹／tokenization 与阈值能够保留有用召回，又不让无关候选淹没人工审阅？
- 哪种同 scope 索引或查询策略可以支持 Hamming 半径检索，而不必每次写入扫描所有记忆？
- 哪些记录类型和陈述长度应排除？
- 指纹通道候选与显式 transition／polarity 命中及现有 token 重叠应如何排序？
- 冻结的产品代表性数据集是否显示有用的召回增益，并且在计入误候选和写入延迟后仍值得采用？

## 6. 研究参考

原稿引用 [claude-memory-system issue #53](https://github.com/nikhilsitaram/claude-memory-system/issues/53)、[Qdrant pull request #8707](https://github.com/qdrant/qdrant/pull/8707) 和字符 n-gram 向量空间方法作为外部先例。这些引用不是 NMG 的复现实测；其阈值和质量结论不得视为项目证据。

## 源码参考

参见 [`src/core/simhash.ts`](../../src/core/simhash.ts)、[tessera 指纹 service](../../src/cli/service.ts)、[tessera 存储与检索](../../src/core/store/retrieval.ts)、[`supersedeCandidates`](../../src/core/store/writes.ts) 和[取代设计](supersession-design.md)。