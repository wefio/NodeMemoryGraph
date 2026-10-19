# PersonaMem 适配器

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

把一份官方问题/上下文对放在 `evals/personamem/data/` 下：

```text
questions_32k.csv
shared_contexts_32k.jsonl
```

其他官方变体请把 `NMG_PERSONAMEM_SIZE` 设为 `128k` 或 `1M`，或直接覆盖
`NMG_PERSONAMEM_QUESTIONS` 与 `NMG_PERSONAMEM_CONTEXTS`。

```powershell
npm run eval:personamem -- validate 1
$env:NMG_BENCH_REPEATS = "3"
npm run eval:personamem -- matched 1
npm run benchmark:score -- personamem <result-directory>
```

独立的打分器应用 PersonaMem 官方的单选抽取规则，且不调用 LLM 判定器。reader
提示词使用上游的 `<final_answer>` 指令。`matched` 从同一份种子语料的隔离副本运行
no-memory、确定性 NMG 与 shadow-controller NMG。

适配器把每个问题连接到 `shared_context_id`，应用官方
`end_index_in_shared_context` 截断，保留多选题选项，并按 PersonaMem 问题类型报告
结果。
