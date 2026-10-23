# LoCoMo arm E 预注册：多路候选池加会话邻接

[English](locomo-arm-e-preregistration-2026-10-23.md) · [术语](locomo-arm-e-preregistration-2026-10-23.terms.yaml)

**Status:** assigned, not run
**Owner:** 邻接探针作者；契约所有者只读复核
**Relates to:** [LoCoMo 本地审计](locomo-local-audit-2026-10-23.zh-CN.md)

## 为什么需要它

两个臂在同一个冻结资格投影上测过，互相**不能替代**：

| 臂 | 多跳 all@20 | 对原问的配对 | 精确双侧 p |
| --- | ---: | --- | ---: |
| A 原问 top-20 | 16.1% | — | — |
| D100max 多路，池 @100，融合到 20 | 20.8% | 16胜3负 | 0.0044 |
| C2 会话邻接 ±2 | 19.4% | 16胜7负 | 0.0931 |
| C2 同字符预算 | 17.9% | 12胜7负 | 0.3593 |

单独邻接替代不了融合；单独融合又会把已召回话轮的相邻话轮留在页外。两者作用在不同的损失上，所以唯一还值得测的组合就是"先融合、再邻接"。本文在结果存在之前把协议固定下来，避免看到数字之后再决定判据。

## 输入（只读，不得修改）

- `raw.D100max`：`evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/raw-candidates.jsonl`（每个合格题 20 条有序记录，含 id、content、score、event_time、stored_at、raw_content）。
- 同一 run 的 `rows.jsonl` 里的 `A.contextCharacters`。
- 邻接探针的纯函数（`selectAnchors`、`expandNeighbors`、`fuseNeighborArm`）与冻结契约里的 `sliceByCharBudget`。
- `evals/locomo/results/locomo-eligible-manifest.json`（sha256 `194ac55a594e…e68d`；多跳 279、回归 145）。

## 固定协议

1. **先跑控制臂。** 用新管线重算 A 与 D100max，必须复现已公布数字（A：16.1 / 73.1 / 38.4；D100max：20.8 / 75.6 / 41.7，16胜3负），再复现 C2（19.4 / 75.3 / 42.2，16胜7负）。任一控制臂复现不上就停下报阻塞——那意味着管线漂移，建立在漂移臂上的组合不是证据。
2. **组合。** 以 D100max 有序列表为 baseline，把前 `anchorCount = 5` 条按内容匹配解析回源话轮（重复文本取首条；歧义与未解析单独计数），同会话 ±2 轮扩展，再按既有规则融合（`keepBaseline = 10`、保留前缀与邻域队列轮转、再填 baseline 尾部、`capacity = 20`）。同法出 radius 1 的敏感臂。
3. **预算视图。** 用 `sliceByCharBudget(E, A.contextCharacters)` 切片。
4. **gold 隔离。** `evidenceIds` 只用于评分。类别、参考答案与证据标签不得进入候选生成、anchor 选择、邻域选择或融合。禁止跨用户、跨会话取邻域。

## 报告

按臂（A、作为对照的 D100max、E、budget E、radius-1 各臂），多跳与回归分开报告：n、any / all / recall、对 A 的 wins / losses / ties、精确双侧二项 p、按 owner 的改善/变差计数、平均上下文字符与相对 A 的增幅，以及未解析 anchor 与歧义计数。

## 判读规则（跑之前固定）

- 若 E 的多跳 all@20 不能显著优于 D100max，或等字符切片把 D100max 的收益吃掉，就停下。v4 多路仍是工作点，邻接只作为"回归类别完整性修复"记录，不作为多跳杠杆。
- 看到结果后**不得调参**。换 anchor 数、半径或容量都是新的预注册。
- 正向结果只使 E 成为第二个组合测量的候选，不成为产品默认，也不建立答案质量结论。

## 边界

零 LLM 调用、零检索请求、不部署、执行方不提交；不修改契约所有者的脚本、raw 产物或共享契约。运行方写自己的结果目录与测试。守卫测试先行：gold 不进入生成、会话边界成立、歧义 anchor 被计数、预算切片精确、控制臂可复现。

验收＝契约所有者用冻结 `pairedComparison` 独立复算该 run 的 rows，再由协调者复核。控制臂复现、配对结果、owner 分布、等预算行为四项都必须给出；**负结果同样是合法交付**。