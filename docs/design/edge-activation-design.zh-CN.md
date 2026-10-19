# 边激活设计

[English](edge-activation-design.md) | [简体中文](edge-activation-design.zh-CN.md) · [术语](edge-activation-design.terms.yaml)

**状态：**当前设计；高级校准仍属实验。**更新：**2026-08-01。

## 1. 原则

**边激活由节点激活推导，不是独立状态变量。**某时刻图的完整状态是节点激活向量 `a(t)`；边提供慢速学习的强度 `w` 与按类型路由规则。边激活、检索上下文和预算都是派生量：

```text
a(t)        节点激活（状态）
w           边强度（慢速参数，通过学习更新）
A_e(u,v)    边激活 = f(a_u, a_v, w_uv, type)（无状态派生量）
```

因此：

- 不持久化每条边的 activation。检索 trace 可以保留派生值作为不可变审计样本，但不能在下一次查询中读回作为边状态。
- 每条边唯一学习的量是 strength；它在 consolidation 时缓慢变化，不在单次 query 内更新。
- 方向、门控和抑制等类型路由规则属于函数族，不应变成散落的特例。

## 2. 激活函数族

导电边的设计级一般形式为 `A_e(u,v) = σ(w_uv · φ(a_u,a_v))`；下表记录目标 relation 语义，不表示每种类型公式都已实现。当前 `propagateEdgeActivation()` 使用有界通式 `source × strength × decay^hop / dilution`，并对 `contradicts`、`supersedes`、`exception_to` 做特殊处理；类型默认值也决定方向及 conductive／regulatory channel。实现边界见 §4。

| Relation 类型 | 形式 | 语义 |
|---|---|---|
| `related_to`、`supports`、`applies_to` | 归一化的 `a_u · a_v` | 弱连接，两端都要激活 |
| `causes`、`depends_on`、`is_a`、`part_of` | 有向 `w · a_u` | 从触发端流动；方向学习见 §3.2 |
| `derived_from` | `w · a_v` | 来源激活时可用的 provenance |
| `contradicts` | `w · |a_u − a_v|` | 激活差异使矛盾可见 |
| `supersedes` | `w · a_new · (1 − a_old)` 门控 | 互斥，不做相加 |
| `exception_to` | `w · a_u · (1 − a_base)` | base 未激活时例外相关 |
| `constraint` | 常量（resident） | 与 query 无关，不受 fan-out 稀释 |

`σ` 可为 identity 或 sigmoid，取决于边是否参与 softmax 竞争池。

### Fan-out 稀释

节点激活是由其出边共享的固定预算。一个节点出边越多，每条边分到的信号越少：

```text
w_uv(effective) = w_uv / (1 + ln(fan_u))
```

这是 ACT-R 风格形式；若邻居在竞争池中，也可用 GAT 风格 `softmax_v(s(u,v)) · budget_u`。边激活因此是竞争性分配，而非彼此独立。该机制也提供一种成本解释：高 fan 节点会稀释信号，因此把扁平索引中的节点 merge 后减少 fan，可能改善检索。

### 调节边的双通道

借鉴 Interactive Activation（IAC）模型，将 excitation 与 inhibition 分开，并限制激活范围：

```text
Δa_i = (max − a_i)·e_i − (a_i − min)·i_i − decay·(a_i − rest)
e_i = Σ_conductive A_e(·,i)；i_i = Σ_regulatory A_e(·,i)
```

`[min,max]` bounds 与 `decay` 是必要条件。若只做无界 diffusion，可能收敛到与 query 无关的固定状态；设计参考记录将此列为检索失效风险。

## 3. 学习规则与强度／稳定性

边强度更新采用 Rescorla–Wagner（RW）形式，而不是原始 co-occurrence：

```text
Δw_e = α · (λ − V_total) · a_u · a_v
```

其中 `V_total` 是预测同一 outcome 的活动边总预测值。其含义是：已被充分预测的冗余线索停止学习；强度趋向渐近值，不会无限增长；只有意外的共同激活才更新边。

`NodeRelation.stability` 与新增设计中的 `strength` 是不同轴：

| 轴 | 含义 | NMG 字段／更新信号 |
|---|---|---|
| strength（可激活性） | 边当前多容易被检索／激活 | `strength`；每次激活与 prediction-error 更新 |
| stability（持久性） | 边多容易长期保留 | 现有 `stability`；consolidation 与 outcome attribution 更新 |
| difficulty | 关联本身的复杂度 | 目前无 NMG 字段 |

Strength 快速变化，stability 在 consolidation 时缓慢变化。前者控制边何时在 AG 激活，后者控制边是否留在 LTG。强激活但低 stability 的边应进入 review，而不是自动 consolidation。

RW／Hebb 学到的 scalar 本身无方向。方向由时间顺序与条件统计提供：`u→v` 可由 u 先于 v 激活推断；strength 可用条件 lift `P(v active | u active) − P(v active)` 表示。`causes`／`depends_on` 需要该 lift；`related_to` 使用对称 joint。相关时间与使用信号来自 `eventTime`、`createdAt` 和 retrieval trace。

Contrastive maintenance 提案使用 `Δw_e = η · (⟨s_u s_v⟩_data − ⟨s_u s_v⟩_model)`，以削弱模型总共同激活、但数据中没有出现的边。这是清理 phantom associations 的研究维护步骤，尚非当前核心行为。

## 4. 当前实现边界

Lite retrieval path 已在 core 实现有界、可检查的边激活核心：

- `src/core/edge-activation.ts` 管理类型默认值、fan dilution、有界传播、导电／调节双通道和有界 RW 更新。
- `node_relations` 持久化 `strength`、`direction`、`fan_budget`、`activation_rule`；migration 为旧行推导安全类型默认值。
- `searchContext()` 从 direct hybrid scores 建立节点激活，在现有 graph-hop budget 内推导边激活，并将传播值用作 graph-expansion route score。
- Active Graph trace 暴露派生 activation 供审计，但不写回 `node_relations`。
- 显式 verified-evidence attribution 才会按 prediction error 更新 strength。单纯被选中、被披露、API answer overlap 或没有反馈，都不算正负证据。

仍属研究／校准的项目包括：学习 temporal direction、contrastive batch unlearning、`HierarchicalActivation` 的第八个 score head，以及基于 mutual information／lift 的自动 compression merge。

## 5. 不变量、合并与未决事项

核心不变量：边 activation 派生、不持久化；strength 只经受控学习路径更新；始终应用 fan dilution；diffusion 受 max hops、阈值和 decay 限制；contradicts／supersedes 不与导电信号求和；merge 必须可由 redirect 回滚；activation 不改写 evidence 或 confidence。

Identity merge 与 compression merge 必须分开：前者需要身份依据，错误合并破坏性高；后者表示节点行为近似为一个检索单位，需更保守并可逆。Compression merge 是索引优化，不是身份断言。FCA 可辅助决定已接受 merge 后节点在概念层级中的位置，但不能决定何时 merge；lattice 本身尚未成为 NMG 数据模型。

初始实现已决定：确定性 edge activation 属于 core retrieval；可微 HA 项仍是 Lab 实验，只有 matched evaluation 证明收益后才晋升。Fan budget 初始采用静态值，先测量再决定是否学习。Contrastive unlearning 的执行位置仍开放，提案是与 retention lifecycle 同批维护，而不是每次 query 执行。

## 6. 当前源码

- [`src/core/edge-activation.ts`](../../src/core/edge-activation.ts)
- [`src/core/types.ts`](../../src/core/types.ts)
- [`src/core/store/retrieval.ts`](../../src/core/store/retrieval.ts)
- [分层激活设计](hierarchical-activation.zh-CN.md)
