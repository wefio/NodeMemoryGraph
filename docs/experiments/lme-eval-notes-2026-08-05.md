# LME 评测流程 + 防回退验证（2026-08-05）

> 固化 LongMemEval（500 问）评测的可复制流程与版本约定，避免每次重复踩坑。
> 与 `docs/design/pmv2-eval-forget-design-2026-08-05.md`（pmv2）配套。

---

## 一、流程与版本约定（重要）

```bash
# 全流程（ingest + search + answer + judge + metric + report）
bash evals/omnimemeval/run-lme.sh --env-file .env.nmg-bgefix --version lme500_bgefix_header_20260804

# 防回退（复用 store + 断点续跑）
bash evals/omnimemeval/run-lme.sh --env-file .env.nmg-bgefix --version <同基线 version> --skip-ingest --llm-workers 16
```

**⚠️ version 必须与基线完全一致**（含 `lme500` 前缀）：
- 基线 version：`lme500_bgefix_header_20260804`（结果目录 `nmg-lme500_*`）
- **version 决定 store 的 userId label**——漏 `lme500` 前缀 → store 不匹配 → search evidence 全空 → recall 0（废结果）
- **跑之前**：`cat results/lme/<基线目录>/experiment_config.sh` 确认 VERSION 原样复制

### 环境
- 必须通过 `run-lme.sh`（固化：PYTHONUTF8/PYTHONIOENCODING/NMG_ROOT/kill_strays）
- **不要直接跑官方 `run_lme_eval.sh`**——会丢 PYTHONUTF8 → rich emoji 打印 GBK 崩溃
- bge-server（8000）独立运行；run-lme.sh 的 kill_strays 不杀它

### 断点续跑（checkpoint/resume——官方自带）
- ingest/search/answer/judge 都按文件存在自动跳过：
  - `nmg_lme_responses.json`（answer 500 全 → 跳过）
  - `nmg_lme_judged.json`（judge 已判定 → 跳过）
- 失败重跑（--skip-ingest）会重跑 search（~2 分钟）但 answer/judge 只补未完成的

## 二、实测性能（16 并发，deepseek-chat）

| 阶段 | 修前 | 修后 | 说明 |
|---|---|---|---|
| answer 500 问 | **~3 小时** | **54 秒** | 每问 `atomic_json_dump` 全量重写 873KB（fsync）→ 批量 checkpoint 25 问一次 |
| judge 500 问 | ~30+ 分钟 | ~1-3 分钟 | 同上（judge 额外每次 `convert_numpy_types` 全量转换） |
| search 500 问 | ~2 分钟 | ~2 分钟 | 与 LLM 无关 |

**性能修复**（fork 本地，可提 PR）：
- `scripts/longmemeval/lme_responses.py`：answer 循环批量 checkpoint（25 问）
- `scripts/longmemeval/lme_eval.py`：judge 循环批量 checkpoint（25 问）
- `scripts/utils/nlp_metrics.py`：`extract_label_json` 容忍 label 后多字段
  （`{"label": "WRONG", "reason": ...}`——旧正则要求 `}` 紧跟 label → 2/500 问 judge 失败）
- **非 429**：16 并发实测 9.3 req/s 零错误——慢的真因是每问 dump

## 三、防回退判定方法

1. 备份基线：`cp -r results/lme/nmg-lme500_bgefix_header_20260804 results/lme/_bak_bgefix_header_20260804`
2. 同 version --skip-ingest 重跑（resume：answer/judge 只补缺的）
3. 对比 `experiment_manifest.json` 的 results 字段：

| 指标 | 基线 | 判定 |
|---|---|---|
| any_evidence_recall / evidence_recall / all_evidence_recall | 94.15 / 87.95 / 82.67 | **必须逐位一致**（检索无回退的硬标准） |
| answer_accuracy | 82.33 | **±2pp 内算 judge 波动**（judge LLM 判定变化实测 28/498 = 5.6%） |

- **2026-08-05 实测**：recall 三项逐位复现（forget 脱敏 + 披露层重构**零检索回退**✓）；
  answer 80.8（-1.53pp）——同 answer 重判 28/498 判定变化（judge 波动），**在波动带内——无回退**。
- answer 文本本身 93% 变化（披露层文本微调——LLM 对 prompt 文本敏感——但语义中立、recall 不变）。

## 四、本次修复清单

| 文件 | 修复 | 状态 |
|---|---|---|
| `scripts/longmemeval/lme_responses.py` | answer 批量 checkpoint | ✅ 已改（fork 本地） |
| `scripts/longmemeval/lme_eval.py` | judge 批量 checkpoint | ✅ 已改（fork 本地） |
| `scripts/utils/nlp_metrics.py` | extract_label_json 容错 | ✅ 已改（fork 本地） |
| 主仓库 `evals/omnimemeval/run-lme.sh` | 环境/断点固化（8/4 已有） | 已有 |
| 主仓库 `docs/design/pmv2-eval-forget-design-2026-08-05.md` | pmv2 配套文档 | 已有 |

## 五、结果目录

- 基线 + 本次防回退：`results/lme/nmg-lme500_bgefix_header_20260804/`（备份 `_bak_bgefix_header_20260804`）
- 防回退跑法回顾：完整经历了 answer 3h（dump bug）→ judge 提取失败（正则 bug）→ version 漏前缀（人工错）→ 修完一遍过（judge 152/152 13s）
