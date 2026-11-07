# 相关性模型的离线探针

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

这里归档的是在真实会话之外测量学习式相关性模型（`src/lab/relevance-model.ts`）
的探针：换一种语言时它的特征还能不能把相关与不相关分开，以及它的判断与真实检索
轨迹里被记为“有用”的记录是否一致。

这些脚本取自 2026-09-29 一份未提交的工作区快照，作为档案落在这里。**它们不附带任何
结果数字**：探针报告当时没有提交，所以本目录记录的是方法与冻结的输入，而不是一次
测量。这里的东西都没有接进 CI、`npm run agent:verify` 或任何评分链路——跑探针是手动
行为。

## 文件

| 文件 | 作用 |
| --- | --- |
| `pair-features.ts` | 共享特征抽取：字符 n-gram 余弦，加上两个探针都喂给模型的成对特征 |
| `multilingual-similarity-probe.ts` | 从 Hugging Face 流式读取 `SemRel/SemRel2024` 句对，用 `statementSimilarity` 与学习模型打分，按语言报告训练/留出划分上的准确率 |
| `local-trace-ranking-probe.ts` | 用本库自己的 `retrieval_traces`（查询、候选、被选中、有用/被推翻/被拒的 id）重放同一套特征，让模型对照记录下来的真实使用而不是公开数据集 |
| `semrel-*.json` | 冻结的划分清单——一次 300 行冒烟，加上三个规范种子（19427／19428／19429）——重跑时得到同一份样本，无需重新推导划分 |

## 运行

两个探针都要用本目录自己的依赖；仓库根目录不提供它们。

```bash
cd evals/similarity
npm install            # @huggingface/hub、hyparquet、hyparquet-compressors
node --experimental-strip-types multilingual-similarity-probe.ts --out report.json
node --experimental-strip-types local-trace-ranking-probe.ts \
  --store ~/.nmg/nmg.sqlite --model weights.json --out traces.json
```

`multilingual-similarity-probe.ts` 接受 `--train-languages`、`--held-out-languages`、
`--epochs`、`--max-pairs`、`--max-rows-per-split`、`--seed` 与 `--model-out`；默认在
`eng,esp,hau,mar,tel` 上训练、留出 `afr,arb,hin,ind,pan`。首次运行会下载数据集，
因此需要网络与磁盘。

`local-trace-ranking-probe.ts` 只读打开库，并且需要一个已训练好的模型文件；它不向
数据库写回任何东西。

## 边界

同一模型在 BPID 身份匹配上的探针在
[`evals/topology/bpid-neural-probe.ts`](../topology/bpid-neural-probe.ts)。它用
`.benchmarks/bpid/data/data_release/matching_dataset.jsonl`（不在本仓库）在同样三个
种子上训练，拒绝精度低于 0.95 或相关保留率低于 0.99 时判该次运行失败。

这些是诊断探针：用来暴露语言覆盖与排序上的缺口、防止回退。它们不是生产占比的估计，
跑通一次也不构成决策——被接受的结果只能经由决策或设计的所有者才成为规范。
