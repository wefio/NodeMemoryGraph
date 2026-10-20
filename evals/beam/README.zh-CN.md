# BEAM 适配器

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

仓库不包含官方 BEAM 数据；请先下载。把 chat 目录放到
`evals/beam/data/chats/100K` 下，或用 `NMG_BEAM_DATA` 指向任意已下载的 BEAM 规模目录。加载器递归发现包含以下内容的 case：

```text
<case>/chat.json
<case>/probing_questions/probing_questions.json
```

```powershell
npm run eval:beam -- validate 1
npm run eval:beam -- matched 1
npm run benchmark:score -- beam <result-directory>
```

独立的评分器使用官方 rubric 语义与 DeepSeek V4 Flash。
`event_ordering` 使用归一化 Kendall tau-b，与 BEAM 的主报告聚合方式一致。judge 替换被明确声明为不可与排行榜比较。

该适配器把 chat 批次展平为保留时间戳的会话，在提供时保留来源 chat ID，并在全部探测问题类别上独立抽样。先从官方 100K/128K 规模的数据下载开始，再转向 500K、1M 或 10M。
