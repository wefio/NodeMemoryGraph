# 渐进推荐：Fibonacci 档位替换固定 limit（QPP 信号修复）

> 依据：`docs/qpp-evidence-signal-experiments-2026-08-02.md` 实验结论——检索信号预测
> "证据完备"最佳为 NQC 归一化离散度（AUC 0.667）；LLM 充分性判断（0.732）验证了
> "判断证据够不够"可行，但判断者是消费者模型本身，故不做 NMG 内建 LLM judge，改为
> **提示词驱动的按需追加**（`MEMORY_POLICY` 已授权：证据不足可请求追加、忽略无关头）。
> 本设计用 Fibonacci 档位替换固定 top-K：首趟按 `initialEvidenceTarget` 给量（默认值
> 可配置，不构成设计主张），QPP 判不够升档，limit 作硬上限；追加 = 消费者模型驱动的
> 爬档（LLM 判断充分性，而非 NMG 内建 judge）。

**Status:** implemented（2026-08-02 实现；阶段三评测后收敛，测试 502/502 通过）
**Updated:** 2026-08-02

## 背景

`nmg_automatic_recall` → `searchContext` 用 `shouldTriggerSecondPass` 决定是否按
Fibonacci 档位展开。实测（`audit-qpp-trigger-stats.ts`，3140 条真实 trace）发现两个问题：

1. **展开从未真正跑动**：QPP C 分数恒 0.92（reasonHealth 恒 1.0 + intentCoverage 恒
   0.5 把 C 抬过阈值），3140 次仅触发 1 次；评测路径第一档（=limit 21 条）就判
   "sufficient" 停，实际等价固定 Top-21；生产路径（Pi 扩展）根本不传 `secondPass`。
2. **Fibonacci 是"固定 top-K + 可选追加"的摆设**，不是"推荐条数决策器"——设计意图是
   单条证据就 1 条、按需 Fibonacci 升档，实现却是固定 limit 打底。

## 需求

- **R1**：Fibonacci 档位替换固定 limit——首趟按 `initialEvidenceTarget`（默认 13，
  `NMG_AUTO_RECALL_INITIAL_TARGET` 可配置）给量，QPP 判不够按 1, 2, 3, 5, 8, ... 升档，
  够了停；`limit` 变为硬上限（最多推多少条）。
- **R2**：QPP 触发信号修复——去掉 intentCoverage/reasonHealth 的常量正贡献（在真实
  benchmark 上无区分度），改为 NQC 归一化离散度（实验最佳 0.667）。
- **R3**：预算护栏——展开不超 `expandActiveGraphBudget` 硬上限与调用方 `limit`。
- **R4**：强单证据信号——相对 top1-top2 gap ≥ 0.05（真悬崖，唯一实测有效的无监督
  信号）→ 首趟 1-3 条；top1 分数本身无判别力，不用。
- **R5**：追加 = 消费者模型驱动的爬档——MEMORY_POLICY 授权 agent 证据不足时请求
  追加；QPP 自动爬档降级为 guardrail（空集 / all-fallback / low-top1）。

## 已实现（2026-08-02）

### 档位循环（`retrieval.ts` secondPass 分支）

```
档位序列：fibonacciEvidenceBudgets(maxEvidence) → [1, 2, 3, 5, 8, 13, ...]
首趟：从 requestedInitial 起（默认 initialEvidenceTarget=13；topGap≥0.05 强单证据
       信号 → 3），逐档 selectWithinBudget(min(target, hardLimit))
       → QPP 判定 → 够则停（sufficient）/ 不够升档 / 到 limit 或预算上限停
limit：硬上限 = min(调用方原始 limit, expand 后 maxEvidence)，不再 clamp 到原始预算
```

修复了三个隐藏问题：
- `requestedInitial` 默认从配置的 initialEvidenceTarget 起（不再是 1）——多证据查询
  一次到位，减少消费者模型追加往返；
- `limit` 入口被 clamp 到原始 `budget.maxEvidence`（`retrieval.ts:114`）→ hardLimit 改用
  调用方原始 `options.limit`，否则升档永远被原始预算挡住；
- 每档记录 stages（target/selected/tokens/qpp/trigger/reason）到 trace，shadow 可审计。

### QPP 信号（`qpp.ts`）

新公式 `C = Top1 + 0.5·NQC`，阈值 `DEFAULT_QPP_THRESHOLD = 0.55`：
- `NQC = stdev(top-k)/mean(top-k)`（clamp [0,1]），衡量 top1 相对其余结果的差距（
  NQC 文献：分数高度离散 = 好查询，对应实验 complete AUC 0.667 最佳信号）；
- 单个候选时 NQC=0 → C 退化为 top1 绝对锚（单条强命中即够，符合"单条证据就 1 条"）；
- `intentCoverage`/`reasonHealth` 仍计算并记录（shadow/guardrail），但不再进 C——
  实测它们在真实 benchmark 上恒 0.5/1.0，是 QPP 永不触发的根因。

### 行为变化

- 强单证据查询（topGap≥0.05）：首趟 1-3 条（最省）；
- 多证据/质量差：从 `initialEvidenceTarget` 起按 Fibonacci 升档到 QPP 判够或 limit/
  预算上限；
- 消费者模型判断证据不足：请求追加（第二趟升档）——追加即爬档，判断者是 agent；
- `secondPass=false`：行为不变（固定 limit + shadow QPP）。

## 测试

- `tests/core/qpp.test.ts`：30 用例（topGap 组件、默认首趟、强单证据、limit 硬上限、
  档位循环、爬档、guardrail）；
- 全量 502/502 通过；`npm run build` 后 dist 同步。

## 验收（阶段三）

固定 top-20 基线对比（LoCoMo 1986 题，oracle 追加上界）：records -27.8%、噪声 -28.6%、
覆盖 +0.8pp——token 更少、噪声更少、覆盖不劣化。详见实验文档阶段三。

## 待办（下一步）

- 阈值 0.55 在 partial-evidence eval 上标定（可选）；
- `NMG_SEARCH_RECOMMENDATION` 完整提示词模板化（当前 MEMORY_POLICY 已含追加授权）。

## 范围外

- 不改变"证据数量（单条/多条）"的任何信号（实验判定不可行）；
- 不做 NMG 内建 LLM judge（判断者是消费者模型本身，提示词驱动足够）；
- 不接 QPP2（列表内压缩），保持独立。
