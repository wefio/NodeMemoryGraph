---
name: verification-traceability
description: 让声明的设计断言可检查、可追溯。新增或修改 contract assertion、选择行为的验证方式，或行为没有预期输出时使用。
---

# 验证可追溯性

[English](SKILL.md) · [使用的术语](SKILL.terms.yaml)

这些规则——每项 assertion 都能解析到 check、没有孤立 check、receipt 中的 coverage 表、frozen rule——由[需求可追溯矩阵决策](../../docs/decisions/implemented/2026-09-08-requirements-traceability-matrix.zh-CN.md)拥有，并由 `rtm:check` 强制执行。不要在这里重复。

本 Skill 只处理那些规则无法强制执行的判断：应该断言什么，以及哪种 check 能为其提供支持。

## 每项主张只写一条 assertion

一条 assertion 是 reviewer 能读懂的一项主张，以及支持它的证据。`statement` 使用 Agent 自己的措辞——它向 Agent 说明任务。`check` 必须可执行——它用来裁决 Agent 的工作。

```yaml
assertions:
  - id: daemon-does-not-depend-on-rcp
    statement: NMG daemon and Core do not depend on or own the RCP
    stage: unit
    check: node-test:daemon-cli
    kind: test
```

## 将 assertion 放在证据链的对应环节

一个 check 只证明一环，不是整条链：requirement、acceptance、implementation、unit、integration、E2E、deployment、observability、real-effect metric。为 assertion 标明实际验证的 stage，绝不要用 unit test 代替最终结果。证据可以是 `node-test:`、`eval:`、`metric:`、`review:` 或 `documented-only`。最后几环由仓库外部拥有时，应明确说明并把 assertion 标记为 `documented-only`，不要借用别人的信号。

## 让 assertion 不超出其证据范围

Check 是一个样本，不是覆盖范围。说明证据实际覆盖的上下文——平台、入口、输入和版本矩阵——不要让 statement 声称更多。“这两个 bin entry point 可在此平台启动”可检查；“这个 package 可用”不可检查，应归为 `documented-only`。

## 验证实际执行边界

新增或修改可运行入口时，先用适用的类型／静态检查器检查实际文件，再用小型 fixture 或受控依赖执行受影响的命令路径。按适用范围覆盖参数／输入处理、分派、输出和失败状态。导入成功及辅助函数测试不能单独证明这些连接成立；在执行到该路径之前就退出的 dry run 也不能覆盖它。

检查须遵守任务权限与[开销边界](../repo-development/SKILL.zh-CN.md#仓库治理)。无法执行真实依赖时，使用受控替身，并说明哪段集成仍未验证。局部检查通过不是启动未经授权外部工作负载的理由。

## 选择实际能失败的最低成本类别

| 情况 | `kind` | 原因 |
| --- | --- | --- |
| 可以写出预期输出 | `test` | 最直接 |
| 所有输入都满足某个关系 | `property` | 示例只是样本；property 不是 |
| 运行期间必须持续满足条件 | `runtime-assertion` | design-by-contract；在边界处失败，而不只是某个 suite 中失败 |
| 没有预期输出 | `metamorphic` | 断言运行之间的关系，而不是某个值 |
| 主张针对结构而非行为 | `coverage` | statement、branch、MC/DC |
| 纯逻辑且“所有输入”都重要 | `proof` | Dafny 或 LemmaScript |

## 没有 oracle？使用 metamorphic relation

NMG 有些行为没有预期输出：retrieval ranking、summaries、consolidation。不要退回到“它运行了”。断言不同运行之间的关系：

- `changedPaths` 对称；两次观察相等时结果为空。
- 新增无关 memory 不得逐出原本相关的 memory。
- 对字节完全相同的输入重新生成 summary，应保持稳定。
- 重排相互独立的输入，不会改变 set-valued result。

## 每个 check 都需要 negative control

不能失败的 check 就不是 check。至少增加一个逻辑出错时能够暴露问题的输入。本地例子是 `NODE_TEST_CONTEXT` 子进程 masking：正向 case 通过时，真实路径却已经损坏。

## `documented-only` 是债务，不是通过

只在无法执行任何 check 时使用，并说明原因。它会继续显示在 coverage 表中，以便 reviewer 提出质疑。绝不要用它把表格刷绿。

## 不要追逐 coverage

Coverage 是分析信号，不是目标。高 coverage 数值配上低 mutation score，说明 check 很弱。报告 mutation score，而不是 assertion 数量。

## 了解 proof 的边界

Proof 检查 contract，不检查意图，也不证明 TypeScript 函数体。在本仓库，可验证的片段很小：classes、`await`、`node:` IO、regex 和 float math 都在片段之外。只有主张是纯逻辑、处于核心位置且值得证明“所有输入”时才使用 `proof`；其他情况使用 `property`。LemmaScript 通过 `//@` 注解真实 TypeScript，因此避免了普通 Dafny 的模型差距。

## 声明 domain，而不只是 property

Assertion 是三元组：`statement` 是 P，`domain` 是 D，`assumes` 是 A。

```
∀ x ∈ D,  A(x) ⇒ P(x)
```

Compiler 要求提供 `domain` 和 `assumes`；`assumes` 的 id 必须能解析到 `docs/design/assumptions.yaml`。`strength` 说明证据能支持什么：`decision` 表示对 D 中每个 x 都裁决 P 的过程；`witness` 表示通过的样本——大多数 `node-test:` 证据都属于此类，因此 `rtm:check` 报告 `bound`，而不是 `verified`。该数量只是清单：gate 根据已记录的执行证据（当前 revision 上的 command 已通过）判定每条 assertion 的状态，并分别审视每个风险类别和跨模块 contract（[该决策](../../docs/decisions/implemented/2026-09-20-rtm-evidence-aggregation.zh-CN.md)）。

模糊的 domain 也能通过 check。用来发现这个问题的工具是 mutation testing：如果一个 mutant 存活，而且其改动落在所声明 domain 之外，说明 `domain` 行写错了，不是测试错了。先写 domain statement，再决定如何处理 mutant。

## 反例必须带 reproducer

“我觉得有问题”的意见，与能展示主张为假的输入，是两回事；只有后者才是 counterexample。质疑记录进入 `.rcp/counterexamples.yaml`：

- `open`——**必须**带 `reproducer`：可以是另一个 Agent 能运行的 command、input 或 case。无法提供时应说明并记录为 `unsubstantiated`；此状态用于让真实但不可证伪的担忧保持可见，而不阻塞工作。
- `resolved`——必须说明发生了什么变化：产品、证据或 `domain` 行。
- `claim` 描述被质疑的内容，不一定要解决。ledger 中尚未登记的主张往往最值得质疑。

`docs:check` 会强制执行这两项要求。要求 reproducer 的原因是：是否接受质疑由 reporter 以外的人决定；模型可以提出疑问，但不能自行裁定。

Claims、assumptions 和 open challenges 位于 contracts、register 与 `.rcp/counterexamples.yaml`。本节只陈述规则一次；推理过程归[主张 ledger 设计](../../docs/design/verification-claims.md)、[domain 决策](../../docs/decisions/implemented/2026-09-09-assertion-domain-and-strength.zh-CN.md)和[reproducer 决策](../../docs/decisions/implemented/2026-09-09-counterexample-needs-a-reproducer.zh-CN.md)所有。