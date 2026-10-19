# LoCoMo 适配器

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

仓库不包含官方数据集；请另行获取。把 `locomo10.json` 放到
`evals/locomo/data/locomo10.json`，或把 `NMG_LOCOMO_DATA` 设为它的路径。

```powershell
npm run eval:locomo -- validate 1
npm run eval:locomo -- matched 1
npm run benchmark:score -- locomo <result-directory>
```

评分步骤调用 LoCoMo 锁定的官方 QA 与证据召回代码。评分前先运行一次 `npm run benchmark:setup`。

该适配器保留会话时间戳与 `dia_id` 证据引用。一次匹配运行在同一上下文预算下比较无记忆、排序原始会话、扁平混合轮次、NMG 节点／leaf 检索，以及一跳 NMG 图扩展。
