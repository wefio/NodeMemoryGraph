# pmv2 评测流程 + forget 撤销设计（2026-08-05）

> 本文件沉淀两件事：① pmv2 快速评测的可复制流程（含基础设施坑与修复）；
> ② forget（撤销）记忆的渲染设计定案与验证结论。

---

## 一、pmv2 快速评测流程

### 一键脚本

```bash
# 60 问（用户 0..59），16 并发 LLM，~1-2 分钟计算
bash evals/omnimemeval/run-pmv2-quick.sh 60 --llm-workers=16
```

脚本位于 `evals/omnimemeval/run-pmv2-quick.sh`，固化处理了以下评测基础设施坑：

| 坑 | 现象 | 修复 |
|---|---|---|
| GBK 控制台崩溃 | rich 进度条 `•` 触发 UnicodeEncodeError，200/200 后崩 | `export PYTHONUTF8=1 PYTHONIOENCODING=utf-8`（**必须在 python 启动前**——env 文件里设太晚，解释器已启动） |
| 全量误跑 | 非流式模式 `--end-idx` 不生效 → 跑全部 47 万行/5000 问 | 截断 `benchmark.csv`（**按问题切分**——每问跨 ~94 行 JSON 引号字段，必须用 Python csv 库；`head -N` 会切断 JSON 导致 Loaded 0/1）`trap` 保证退出/中断时恢复） |
| WinError 5（os.replace） | `atomic_json_dump` 的 `os.replace` 被 Defender/索引器短暂锁住（实测 3200 次并发 ~0.4% 概率） | 失败自动重跑（计算 ~1 分钟/次，重跑比修锁便宜；脚本自带 checkpoint resume 兜底） |
| 缺 `--lib` 参数 | `Error: --lib is required in normal mode` | 显式 `--lib nmg`（默认 version 变为 `nmg-omnimemeval_<date>`） |

### 关键事实

- **实际计算量极小**：60 问全管线 ~22s（ingest 1s + search 15s + answer 4-5s@16并发 + metric/report）。
  之前"68 分钟"是 subagent 墙钟时间（含全量误跑、健康检查、重试、两次未完成尝试的 overhead），**不是评测本身**。
- **LLM_WORKERS 并发安全**：`pm_responses.py` 是 asyncio 单进程并发（`asyncio.Semaphore` 控并发）+ `atomic_json_dump` 原子写——多 worker 不撞锁（WinError 5 是文件系统级偶发，非并发设计问题）。16 并发实测 **0 次 429 rate limit**。
- **范围限制**：官方脚本无用户数参数（`--end-idx` 仅 streaming 模式有效）。唯一可靠方法是截断 csv（ingestion/search/responses 读同一文件，截断后各阶段一致）。
- **评测链路**：`bge-server`（`evals/omnimemeval/bge-server.py`，uv 启动）提供 OpenAI 兼容 `/embeddings`（BAAI/bge-small-en-v1.5，端口 8000）；`--env .env.nmg-bgefix`；embedding-cache.sqlite（1.1GB）跨 run 复用，重跑便宜。
- **判分内联**：pmv2 是 MCQ——`is_correct` 在 `pm_responses.py` 里**每问 answer 完本地判**（chosen == golden），`pm_metric.py` 只做统计（秒级）。**没有独立的 judge LLM 阶段**（那是 LongMemEval 的流程）。

---

## 二、forget（撤销）记忆渲染设计

### 设计历程（三轮迭代）

1. **原文 + 标记**（旧版）：`[forget] I enjoy modern electronic music festivals` + 长 hint
   （"do not use or reconstruct..."）。
2. **脱敏**（用户提议）：自动推荐只给 `memory=id` + `[forget] (content withdrawn)`——要内容必须主动 `nmg_get`（意图门槛）。
3. **元数据 + 脱敏**（定案，`cfb982f`）：**保留 Agent 可用的语义元数据**（id/node/type/time），**不给 statement**。当前各适配器共用同一个投影，不再暴露存储层级、匹配机制或分数：

```
memory=m-9; node=Event preferences; type=preference; time=2025-09-01;
preview=[forget] (content withdrawn)
```

- `forget_hint`（简化为）：`A line beginning with [forget] is a revocation boundary; treat it as revoked.`
  （内容已不在 prompt 里，无需长解释"不要重建"）
- **当前共享边界**：`nmg_get` 也只返回撤销元数据与 `[forget] (content withdrawn)`；原文可以留在审计存储中，但不再回到模型上下文。
- 模板单一来源：`src/prompts/nmg-prompts.yaml` 的 `search_disclosure` / `forget_hint`。

### 语义理由（为什么是元数据+脱敏，而不是原文）

- **防引用是硬需求**：验证证明 LLM **标记在场也会引用被撤销内容**（原文版 4/11 泄漏）。
  引用被撤销内容 = 违背用户意愿的最严重错误。脱敏让模型**无内容可引用**（硬保障）。
- **知道忘什么 vs 引用风险**：完整原文让模型知道"忘的是什么"（针对性回避）——
  但代价是它可能引用（对齐不可靠）。脱敏失去针对性回避，但换来引用零风险。
- **元数据保留**：模型仍看到"存在一条撤销记录 + 身份"（id/类型/时间）——
  撤销可识别，但没有内容可重建。

### 验证结论（pmv2 60 问，三次独立 run）

| 渲染 | run | ask_to_forget 泄漏（连续短语重叠法） | 总体 acc |
|---|---|---|---|
| 原文 + 标记 | 155659 | 4/11 | 0.300 |
| 脱敏（content withdrawn） | 165251 | 4/11 | 0.267 |
| 元数据 + 脱敏（定案） | omnimemeval_20260805 | **0/11** | 0.317 |

- **输入层脱敏确认生效**：脱敏 run 11/11 条 context 无原文（全部 `[forget] (content withdrawn)`）。
- **但泄漏指标不可靠（0-4/11 波动）+ 与渲染无关**：
  - 该 benchmark 的干扰项**选项文本本身嵌入了被撤销内容原文**
    （如选项 (b) 自己写着 "draw from the atmosphere of **modern electronic music festivals**"）。
  - 模型**无需记忆，光看选项就能选中"泄漏项"**——9/11 选项选择与脱敏前完全一致。
  - LLM 输出随机性使泄漏数在 0-4/11 间波动（同批 60 问三次跑 acc 0.300/0.267/0.317，±5%）。
  - MCQ 输出只有选项字母——无法做输出溯源（区分"真用记忆" vs "选项文本诱导"）。
- **结论**：脱敏在输入层完全生效；泄漏指标既被选项设计主导、又随 LLM 随机波动——**无法衡量渲染的行为收益**。定案选择基于语义（防引用硬保障），不基于该指标。

---

## 三、相关文件

- 评测入口：`evals/omnimemeval/run-pmv2-quick.sh`（一键 60 问）
- embedding server：`evals/omnimemeval/bge-server.py`（uv 启动，OpenAI 兼容）
- 提示词单一来源：`src/prompts/nmg-prompts.yaml`（`search_disclosure` / `forget_hint`）
- 渲染实现：`.pi/extensions/nmg/index.ts`、`claude-plugins/nmg-memory/agents/memory-copilot.ts`、
  `evals/omnimemeval/bridge.ts`
- 结果目录：`.benchmarks/official/OmniMemEval/results/pmv2/nmg-pmv2_20260805_165251/`（脱敏验证 run）
