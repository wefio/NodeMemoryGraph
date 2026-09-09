# LongMemEval 94.15% 基线"漂移"定位：embedding profile 回归（2026-08-03）

> 结论先行：**不是检索机制回归，是 embedding 配置漂移**。`NMG_EMBED_PROFILE` 丢失后
> 默认回落 `qwen3`，BGE 模型的 query 被套上 `Instruct: ... Query: ...` 模板，破坏 query
> 语义，LongMemEval any-evidence recall 从 **94.15% 掉到 76.0%**。恢复
> `NMG_EMBED_PROFILE=bge-en` 后以 94.15%/87.95% 精确复现历史基线，动态 QPP 机制
> 在修复配置下进一步提升到 **95.19%/89.71%**。

## 背景

历史 LongMemEval any-evidence recall 基线 94.15%（`nmg_lme500_bge_merged_20260728`、
`nmg_bge_wide20_merged_20260801` 两个 run 同一数字）。当前代码固定 top-20 重跑只有
76.0%，18pp 差异一度指向代码/向量环境回归。本实验完整定位并修复。

## 定位过程（证据链）

1. **代码排除**：wide20 时代 commit `ecdd661` 原样重跑固定 top-20 = 76.0%（与当前
   B0 几乎相同）→ 不是代码差异；git diff `ecdd661..HEAD` 中 base.ts/select 逻辑零改动。
2. **数据排除**：B0 store（user 5）469 条记录完整、向量覆盖率 100%，证据记录存在。
3. **排序差异实测**：同 query「What was my last name before I changed it?」+ 同 store：
   - `profile=qwen3`（默认）：证据 rank **14** → top-12 token 截断漏掉 → 76%
   - `profile=bge-en`：证据 rank **5** → 命中
   - `profile=plain`：证据 rank **9** → 命中
4. **hash 溯源**：embedding cache 中当前 index hash `e84bb38b824d` 全部在 08-03 生成；
   08-01 的 `e20245358378`（1645 条）只是调试 session。用代码重现：
   - `qwen3` profile → `e84bb38b824d`（当前默认 ✓）
   - `bge-en` profile → `1e9807091681`
5. **全量验证**：`NMG_EMBED_PROFILE=bge-en` + 固定 top-20 全量重跑 → **any=94.15%
   overall=87.95%，类别级与历史 run 完全一致**（knowledge-update 100.00/99.31、
   multi-session 97.60/85.63、temporal 88.64/83.01）。

## 根因

`src/core/embedding-providers/openai.ts` 的 `commonOpenAiOptions` 默认
`profile: profile(environment, "qwen3")`——无论模型是什么，未设
`NMG_EMBED_PROFILE` 时一律用 qwen3 模板。BGE 系列模型（BAAI/bge-small-en-v1.5）
的 query 提示是 `Represent this sentence for searching relevant passages: {text}`；
qwen3 模板 `Instruct: {instruction}\nQuery:{text}` 会让 BGE query 向量偏离，系统性
劣化排序。历史 run 的 env 显式设置了 profile（或当时默认行为不同），08-02/03 期间
env 被重写后丢失该行，静默回落到错误的 qwen3 模板。

## 修复

`commonOpenAiOptions` 按模型自动选择默认 profile：model 名含 `bge` 时默认
`bge-en`，否则 `qwen3`；显式 `NMG_EMBED_PROFILE` 始终优先。新增单测
（bge 默认 bge-en / 显式覆盖 / 非 bge 保持 qwen3 / indexId 区分）。

## 修复后 LongMemEval 全量矩阵（n=479，any-evidence recall）

| 配置 | any | overall | answer acc | 平均记录数 | 说明 |
|---|---|---|---|---|---|
| 历史基线（07-28 / 08-01 wide20） | 94.15% | 87.95% | — | ~12 | bge-en + 固定 top-20 |
| 修复后固定 top-20 | 94.15% | 87.95% | 81.2% | 15.1 | 精确复现历史 |
| **修复后动态 init13（无 strong hit）** | **95.19%** | **89.71%** | **82.3%** | 20.5 | 优于固定基线 |
| 漂移期固定 top-20（qwen3 默认） | 76.0% | 62.3% | — | 12 | 回归期对照 |

动态机制（QPP init13 + Fibonacci 渐进，strong hit 关闭）在修复配置下仍全面优于
固定 top-20：any +1.04pp、overall +1.76pp、answer 正确率 +1.1pp（81.2% →
82.3%）。类别级亮点（answer 正确率）：single-session-preference 73.3 vs 66.7
（+6.6pp）、single-session-assistant 98.2 vs 94.6（+3.6pp）、knowledge-update
86.8 vs 84.6（+2.2pp）、multi-session 75.8 vs 74.4（+1.4pp）；single-session-user
（-1.5pp）与 temporal（-0.7pp）小幅回退。代价是平均记录数 20.5 vs 15.1（token
更高，QPP 爬升部分）。

## 教训

- 向量检索配置（profile/模板）错误是**静默的**：没有报错，只是排序变差。indexId
  hash 变更 + 全量 cache 失效是配置漂移的第一信号。
- 历史基线对比前必须先确认**配置可复现**（本案例 18pp 差异 100% 来自配置，0% 来自
  机制）；用同 commit 重跑 + 类别级对比（而非只比总分）能快速定位。
- 代码默认值要按模型适配（bge → bge-en），不能给所有 OpenAI 兼容端点一个 qwen3
  默认模板。
