# LongMemEval 评测流程与防回退验证（2026-08-05）

[English](lme-eval-notes-2026-08-05.md) | [简体中文](lme-eval-notes-2026-08-05.zh-CN.md) · [术语](lme-eval-notes-2026-08-05.terms.yaml)

**状态：**有日期的历史评测记录。以下脚本、命令与时长描述 2026-08 的运行，不是当前工作流说明。请使用 [OmniMemEval 评测 Skill](../../../.pi/skills/omnimemeval-eval/SKILL.zh-CN.md) 与当前配置。相关：[PersonaMem v2 与 forget 渲染记录](../../design/pmv2-eval-forget-design-2026-08-05.zh-CN.md)。

## 历史工作流与版本契约

记录中的 LongMemEval run 使用：

```bash
# 全流程：ingest + search + answer + judge + metric + report
bash evals/omnimemeval/run-lme.sh --env-file .env.nmg-bgefix --version lme500_bgefix_header_20260804

# 防回退：复用 store 并断点续跑
bash evals/omnimemeval/run-lme.sh --env-file .env.nmg-bgefix --version lme500_bgefix_header_20260804 --skip-ingest --llm-workers 16
```

对当时的 runner，version 必须与基线完全一致，包括 `lme500` 前缀。报告称 version 决定 store 的 `userId` label：漏掉此前缀会选择不同的 store，导致 search evidence 为空、recall 为零，结果无效。记录中的运行前检查是查看 `results/lme/<baseline-directory>/experiment_config.sh`，逐字复制 `VERSION`。

该 wrapper 固定了 Python UTF-8 设置、`NMG_ROOT` 与 stray-process 清理。笔记警告，直接调用上游 `run_lme_eval.sh` 可能丢失 `PYTHONUTF8`，Rich 在 GBK 控制台打印 Unicode bullet 时会失败。Port 8000 上的 embedding server 独立运行，不会被 `run-lme.sh` 终止。

Runner 根据文件存在情况恢复：完整的 `nmg_lme_responses.json` 会跳过 answer 生成；完整的 `nmg_lme_judged.json` 会跳过 judge。失败后使用 `--skip-ingest` 重跑会重新执行 search（报告约两分钟），只补完未完成的 answer／judge 行。

## 历史性能观察（16 并发，`deepseek-chat`）

| 阶段 | 修复前 | 修复后 | 报告中的解释 |
|---|---:|---:|---|
| Answer，500 问 | 约 3 小时 | 54 秒 | 每问 `atomic_json_dump` 都用 fsync 重写 873 KB 文件；每 25 问 checkpoint 减少了写入 |
| Judge，500 问 | 30 多分钟 | 1–3 分钟 | 类似的写入开销，另有重复的全量 `convert_numpy_types` 转换 |
| Search，500 问 | 约 2 分钟 | 约 2 分钟 | 不受 LLM 调用影响 |

报告称 16 路并发达到 9.3 requests/second 且零错误；延迟归因于逐问文件 dump，而不是 429。这些是历史测量，不是当前性能保证。

报告记录的本地 fork 改动：

- `scripts/longmemeval/lme_responses.py`：每 25 问批量 checkpoint answer。
- `scripts/longmemeval/lme_eval.py`：每 25 问批量 checkpoint judge。
- `scripts/utils/nlp_metrics.py`：令 `extract_label_json` 接受 `label` 后的字段，例如 `{"label": "WRONG", "reason": ...}`；报告称旧正则导致 2/500 个 judge 失败。

## 历史防回退判定规则

报告先备份基线结果目录，再用同一 version 和 `--skip-ingest` 重跑，随后比较 `experiment_manifest.json` 的 results。

| 指标 | 基线 | 历史判定规则 |
|---|---:|---|
| `any_evidence_recall` / `evidence_recall` / `all_evidence_recall` | 94.15 / 87.95 / 82.67 | 要求逐位一致，作为无检索回退检查 |
| `answer_accuracy` | 82.33 | 将 ±2 个百分点视为 judge 波动；报告测得重判变化 28/498（5.6%） |

对 2026-08-05 rerun，报告称 forget 脱敏与披露层重构后，三个 recall 数值均精确复现。Answer accuracy 为 80.8（-1.53 pp），在所述 judge 波动范围内。披露文本调整后，93% 的 answer 文本发生变化，而 recall 未变。

## 历史结果位置与局限

基线和防回退 run 记录在 `results/lme/nmg-lme500_bgefix_header_20260804/`，备份目录为 `_bak_bgefix_header_20260804`。报告描述此前依次遇到 dump bug、judge 提取正则 bug、人工漏掉 version 前缀；修复后最后一次 run 在 13 秒内完成 152/152 条 judge。

这些结果只适用于当时的 benchmark 设置与本地 fork。它们不能证明当前 runner 接口、吞吐或普遍回答质量稳定性。当前复现与配置指引归评测 Skill 和 `evals/omnimemeval/` owners 管理。