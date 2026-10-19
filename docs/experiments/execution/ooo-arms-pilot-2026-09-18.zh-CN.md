# 使用真实模型测量粒度 arms - 2026-09-18

[English](ooo-arms-pilot-2026-09-18.md) · [术语](ooo-arms-pilot-2026-09-18.terms.yaml)

**状态：**A–D 付费测量共 14 次运行、29 次模型调用，使用一个模型。E arm 另行运行两次：首次 8 次尝试；第二次保留证据的运行中有 9 个付费 unit。**仅具方向性**：样本无法区分较小差异，也没有可供分辨的质量差异。

[归档](archive/ooo-arms-2026-09-19/README.zh-CN.md)逐字保留 D/E 与 cap experiment 的报告；A/B/C 只有汇总结果，逐次运行文件未存入仓库。[计划](ooo-arm-plan-2026-09-19.zh-CN.md)记录后续付费运行必须在启动前保存的内容。这些是研究工具测量，不证明存在产品运行时调用方。

设计规定真实模型阶段“须另行明确模型、预算与重复次数”，并报告**质量 / wall time / token / host 成本 / 浪费成本 / 人工介入**；“没有同等父产物质量，不得声称加快”。本文固定这些输入，报告这六项，并且不声称样本无法支持的结论。

## 固定了什么，哪些留给各 arm 改变

| 输入 | 值 |
| --- | --- |
| Model | `PI_PROVIDER=deepseek`、`PI_MODEL=deepseek-v4-flash`（session 自身使用的模型，显式传入，不使用默认值） |
| Envelope 限制 | `turns: 6`、`reads: 3`、`timeoutMs: 120_000`——所有 arms 相同，且高于 host 默认的 3 |
| 重复次数 | A 3、B 3、C 2 |
| Arm 顺序 | 通过 seeded shuffle（`--seed`）抽取，并打印在结果中，因此顺序可复现 |
| 任务族 | `evals/ooo-execution/fixtures/pipeline`——**留出族**：它在 driver 与 report family 之后编写，不是工具构建时所依据的任务族 |
| Arms（唯一变量） | A = 整项任务作为一个 unit；B = 相同工作拆成四个 unit、一个槽；C = B 使用两个槽 |
| 未固定项 | wall-clock 时刻、host 负载、模型自身采样——任何 arm 都无法控制这些因素 |

各 arm 的冻结 envelope 完全相同：10 个 baseline 文件、相同的组合 parent check、相同的 unit checks 和相同限制。两份 spec 都先离线检查：使用 `evals/ooo-execution/families.test.ts` 中工具自身的答案与错误答案（两个任务族共 8 个用例）。如果工具无法离线证明某计划能被接受，就不值得付费运行。

## 测量

命令 `node --experimental-strip-types evals/ooo-execution/pilot.ts --live --out <results.json>` 运行了 8 次，共 23 次模型调用，全部完成（没有失败、超时、重试或被拒绝的提交）。之后用 `pilot.ts --report a.json,b.json` 合并结果；这一步不调用模型，并会拒绝合并使用不同工具的报告。D arm（fusion，另外 6 次运行与 6 次模型调用）于 2026-09-19 加入，并在下方单列。

| Arm | 计划 | Slots | 运行数 | 已接受 unit | Parent | Wall 总计（中位数） | Host 总计 | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | coarse，1 unit | 1 | 3 | 1 / 1 / 1 | accept ×3 | 25 654 ms（7 319） | 4 693 ms | 33 677 |
| B | fine，4 units | 1 | 3 | 4 / 4 / 4 | accept ×3 | 64 385 ms（20 600） | 10 103 ms | 94 601 |
| C | fine，4 units | 2 | 2 | 4 / 4 | accept ×2 | 32 461 ms（17 060） | 7 241 ms | 59 830 |

每次运行：A 为 8.6 秒、11.2k tokens；B 为 21.5 秒、31.5k tokens；C 为 16.2 秒、29.9k tokens。每次运行的 host 成本：A 为 1.6 秒（一个 candidate），B 为 3.4 秒、C 为 3.6 秒（各四个 candidate）。运行次数不同，因此表中的总计是相加值；下方所有比率均按单次运行计算。

**质量。** 所有运行中的每个 unit 都通过自己的冻结检查；两种计划的组合 parent check 在 8 次运行中全部接受。因此这些 arms 可比较（`comparePlanSlots` 在此应返回 `comparable: true`），而且对该模型而言，此任务族很容易——这才是诚实的读法。也正因如此，本 pilot 无法说明不同粒度之间的质量差异：没有可测的质量差异。设计规则只在狭义上满足（parent 质量相同），并不满足强意义上的要求：若 coarse arm 在更难任务中退化，就不能继续声称加速。

**浪费成本。** 零。没有提交被拒绝，没有尝试被放弃，也没有工作需要重做。`--live` pilot 按运行记录 `incomplete` 并保存各自的结果文件，正是为了让浪费成本可追溯；大的 `wasted` 数值必须从这些文件得出，不能从 token 总量推算。

**人工介入。** 运行期间没有。运行前发现并测量了两项环境问题；没有绕过，而是在此记录。见下一节。

## 离线 sweep 的预测及实际结果

离线 sweep 给出三项预期。它们在留出任务族上全部成立，且付费模型不同于 sweep：

1. **“一个槽没有收益；单槽细分总是亏。”** 相同接受工作量下，B 的 wall time 是 A 的 2.5 倍，tokens 是 2.8 倍。结果确认了 sweep 的方向：若 pilot 报告 B 比 A 便宜，首先应怀疑测量。
2. **“只有独立性与槽数都真实存在，拆分才有收益。”** 按单次运行计算，C 收回了 B 的部分损失（16.2 秒对 B 的 21.5 秒，为 0.76 倍；29.9k tokens 对 31.5k，为 0.95 倍），但远未达到“只有模型调用成本时两槽可重叠”的 2 倍。一个 unit 仍需等待三个依赖项，host candidate checks 也不能并发。该规模下能看到 sweep 的转折点：出现 critical path 后，节省开始缩小。
3. **“host check 队列限制了细粒度并发。”** Host 成本随 candidate 数量增长，而不是随槽数增长：一个 candidate 每次运行 1.6 秒，四个 candidate 则为 3.4 与 3.6 秒；C 的额外槽完全没有节省 host 时间。

Sweep 无法预测 token 价格：它只模拟时间；fine plan 的四次模型调用都要再次携带冻结快照，这正是 2.8 倍差异的来源。这是本文唯一一个离线层未预测的数字，却是付费计划最重要的成本之一。

## 本文不说明什么

- n = 8。B、C 之间 25% 的 wall-time 差异，在此样本中只相当于一次运行差异；方向与 sweep 一致，但差值大小不是结论。
- 只有一个模型。若模型一轮而不是四轮就能回答，模型时间与 host 时间的比例会变化，而三项预测都依赖这个比例。
- 只有一个留出任务族，且形状与工具自身接近（冻结 interface、三个独立 builder、一个依赖三者的 summary）。没有共享 interface，或是 chain 而非 fan-in 的任务形状，都不在测量范围内。
- 任务族很小，模型可以一次完成。本文不测量尝试失败时会怎样，而槽数最可能在这类场景中发挥作用。

## 结果前修复的两项环境发现

1. **尝试的第一轮模型调用经常 aborted。** 经常出现 `pi turn error: This operation was aborted`（对已有 `evals/ooo-execution/live-patch.ts` 的 live probe 在 host 默认 3 turns 时有 2/6 次失败；清除嵌套 session 自身环境变量 `PI_SESSION_FILE`/`PI_SESSION_ID` 后成功）。这轮调用通常 abort 后尝试仍会继续，因此 pilot 将所有 arms 的 `turns` 固定为 6，而不是把该 abort 当作 worker 失败。这是工具观察，不是 arm 间差异，并且所有 arms 一致处理。
2. **提交的 patch 携带 unit 的整个冻结视图。** `runParentCheck` 原先用每个已接受提交覆盖 parent candidate，因此最后一个 unit 未更改的兄弟文件副本（它冻结时的 stubs）会覆盖此前工作。随后 parent check 会拒绝一份所有 unit 都已接受的计划。现在只组合 unit 实际修改的文件（新 family cases 捕获了 mutant `the-parent-takes-the-last-units-whole-view`）。

## 命令

```text
# 先离线验证两个任务族、两种计划、工具的答案与错误答案
node --experimental-strip-types --test evals/ooo-execution/families.test.ts

# 付费 pilot（A 3 / B 3 / C 2，共 23 次调用），再无模型调用地汇总同一结果
node --experimental-strip-types evals/ooo-execution/pilot.ts --live --out .temp/pilot/pilot.json
node --experimental-strip-types evals/ooo-execution/pilot.ts --report .temp/pilot/pilot.json \
  --out .temp/pilot/pilot-summary.json
```

## D arm：fusion（2026-09-19 加入）

D arm 比较一个 session 连续运行两个 unit 与两个 session 各运行一个 unit 的成本——即设计中的 `fusion` 边界。它需要 extension 原先没有的机制：让一个 session 跨 unit 保持。`--session-runner` 提供此能力（每个 driver session 保留一个 Pi session，并按 unit 重新指向）。两臂唯一差异是 `fusion.unitsPerSession`：1 是 driver 已支持的对照，2 表示融合。其余完全相同：同一个 spec、同一 envelope（`turns: 6`、`reads: 3`、`timeoutMs: 120 000`）、`--slots 1`、同一模型，各三次重复。

| Arm | 每 session 的 units | 每次运行的 Pi sessions | 接受的 units | Tokens 中位数 | Wall 中位数 | 失败数 |
| --- | --- | --- | --- | --- | --- | --- |
| unfused | 1 | 2 ×3 | 2/2 ×3 | 22 498 | 12 948 ms | 0 |
| fused | 2 | 1 ×3 | 2/2 ×3 | 22 533 | 11 048 ms | 0 |

**此样本支持什么。** 质量相同：两臂每次运行的每个 unit 都被接受，因此 wall-time 比较有效。fused arm 的每次运行中位数快约 1.9 秒：unfused 为 11.8 / 9.6 / 11.0 秒，fused 为 11.9 / 12.9 / 14.1 秒；约为 unfused 中位数的 15%。

**1.9 秒不能证明什么。** 同一组数值否定了本节最初的解读：中位数差（1.9 秒）小于两臂各自的 spread（均为 2.2 秒），因此每臂三次重复仍无法区分 session 启动项与普通运行间模型耗时；也不能说“差值大于任一臂自身的 spread”。在归档中的 cap experiment 测量之前，启动项仍是成本模型记录的未测参数；该实验显示它依赖计划形状，而非固定常数。

**此 arm 没有分辨出 fusion 是否有效。** 归档里的 cap experiment 在四单元 fine plan 上进行同一比较，测得正向 wall-time 效果：cap 1 调至 cap 2 的三次重复中位数节省 8 451 ms，cell 内 spread 分别为 1 783 ms 与 571 ms。前两次重复也已分离（cap 1 为 26.2–27.1 秒，cap 2 为 17.7–18.0 秒）；第三次重复使用了较新的 prompt。仍未分辨的是融合的**成本**：三次重复的 token spread 大于比较差值，而不是 wall clock 是否节省。

**此 arm 不能证明什么。** Tokens 没有减少：22 498 对 22 533，差 0.2%；fused arm 自身的 spread（17.6k–26.3k）大于两者差异。逐 unit 数字也只说明方向，不是节省：fused 第二个 unit 约 10.8k，对比 unfused 约 11.6k（约 8%），处于该 spread 范围内；第一个 unit 反而多花约 0.7k，抵消了这项差异。下方机制假设未由该样本检验，而且其中一部分已于 2026-09-19 修复：chain 不再向不需要该 tool 的 unit 提供该 tool（见[fusion trial](./ooo-fusion-trial-2026-09-19/README.md)），因此重跑不应预期复现该项成本。

**驳回的结论：** 把 token 持平读作“fusion 没有收益”。两项成本可以分开，第二个 unit 的节省是真实读数；但单一计划形状、单一模型下的 n=6，无法说明任一项如何扩展。

```text
node .temp/run-darm.mjs   # 6 次付费运行（每个 bound 3 次）；写入 .temp/darm/*.json 与汇总
```

## E arm：bounded speculation（首次运行，2026-09-19）

E arm 在 D arm 的机制上增加一个声明事实：这一轮是否还需要该 unit。这是设计认定可合法推测的场景，因为该事实决定工作是否发生，而不是工作会读取什么。工具是 `evals/ooo-execution/speculation-pilot.ts`：在事实确认前准备 candidate，再由共享层的 `speculationOutcome` 决定其后续。发布的 candidate 仍由 host 使用该 unit 自己的冻结检查验证，这是质量项；丢弃时会关闭其 branch session。

| Arm | Fact | 运行数 | Tokens | Work ms | Fact 确认后的 ms | 质量 |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | holds | 2 | 13 544 | 10 358 | 10 358 | false ×2 |
| speculation | holds | 2 | 17 151 | 15 066 | 186 | false ×2 |
| baseline | absent | 2 | 0 | 0 | 0 | n/a |
| speculation | absent | 2 | 12 543 | 15 577 | 0 | n/a |

**不得声称加速。** 四个经过验证的 candidate 质量项全部为 false：每个提交的 patch 都未通过 unit 自身的冻结检查。设计规定质量不相同就不能报告延迟与成本，所以以下只是该 arm **本来要测量的形状**，不是有效结果。

**该形状意味着什么。** Speculation 总是要为 unit 付费：事实最终为 false 时仍花费 12 543 tokens，这正是浪费成本测量的对象。事实为 true 时，它有机会收回工作延迟：对照组需要 10 358 ms 工作时间，而预先准备 candidate 后事实确认只需 186 ms 验证。因此 arm 的经济性取决于命中率；设计中的 utility 公式也如此，而此样本无法定价。

**首次运行发现的两项问题，第二次运行更正了其中一项。** 工具在失败时删除 candidate tree，因此无法解释所有检查为何失败。首次报告还指出一个看似存在的 adapter/host 不匹配：`artifactEnvelope` 接受了包含 `digest, kind, conclusion, summary, evidence, citations` 而没有 `files` 的 candidate，但 `patchCandidate` 以 `invalid patch structure` 拒绝。第二次运行确认了 tree 未保留的问题，但更正了不匹配的说法：`artifactEnvelope` 合法支持 patch 和 conclusion 两种形状；实际缺陷是 harness 把所有 artifact 都送入只处理 patch 的 reader。第二次运行的 9 次尝试中，8 次产出 conclusion artifact，该 unit 的 check 无法接受；唯一一次 patch 尝试则因写成 `rows: [...]` 而不是冻结 interface 要求的 `lines: [...]` 失败。工具现在按 artifact 类型选择 reader，并保留失败时的 candidate tree 与 check 输出。

## E arm：第二次运行，有证据（2026-09-19）

第一次 E-arm 运行报告了无法解释的质量失败，因为没有保留 bytes。第二次运行保留了所有内容（artifacts、candidate trees、check 原始输出、逐次尝试一行），回答了失败原因与经济性两个问题。每种条件重复 3 次，共 9 个付费 unit，约 62k tokens。

| Arm | Fact | Tokens（3 次总计） | Work ms | Fact 确认后的 ms | 质量 |
| --- | --- | --- | --- | --- | --- |
| baseline | holds | 18 183 | 19 200 | 19 200 | 通过 0/3 |
| speculation | holds | 18 602 | 19 506 | 175 | 通过 0/3 |
| baseline | absent | 0 | 0 | 0 | n/a |
| speculation | absent | 20 332 | 23 920 | 0 | n/a |

**先诊断（P1）。** 在读取本次结果前，harness 的检查路径已通过离线验证：冻结 stub 会失败、fixture canned answer 会通过、错误答案会失败，两个 unit 都如此；因此失败检查反映了实际结果。第一次运行看不到的是：9 次尝试中有 8 次返回 **conclusion** artifact（“不需要改动”）。这对允许该结论形状的任务是合法 artifact，但它不含文件，因此不能通过本 unit 的检查；board 也会因此拒绝。唯一一次 patch 尝试是实际错误：它写了 `rows: [...]`，而冻结 interface 要求 `lines: [...]`。这里没有 envelope 缺陷；此前“extension 比 host 宽松”的结论是错的，已在归档 README 更正。

**经济性（P2）。** 机制按设计形状工作：事实为 true 时，fact 确认后的成本从实际工作本身（中位数约 6.2 秒）降为验证预先准备的 candidate（唯一一次产出 candidate 的重复为 175 ms）；事实为 false 时，全部投入都浪费——20 332 tokens，比需要时再做更多。**不声称收益，也没有可得收益：**事实为 true 的 3 次重复中，candidate 0 次可发布，延迟项从未成为真实收益。在此形状——这个模型、这个 unit 指令、这个事实——bounded speculation 有实际成本、没有实现收益；约束来自 candidate 是否可接受，而非机制速度。
