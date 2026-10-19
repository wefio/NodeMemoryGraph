# 归档：arms 付费运行记录（2026-09-19）

[English](README.md) · [术语](README.terms.yaml)

**保留原因。** D arm（fusion）和 E arm（bounded speculation）在一个 scratch 位于 `.temp/` 的工作树中运行；`.gitignore` 会排除该目录。此前的记录引用了数字——22 498 对 22 533 tokens、12 948 对 11 048 ms，以及 E arm 的质量失败——但这些数字所依赖的文件会随下一次 temp 清理一起消失。这是本分支第二次遇到同类问题：G7 之后曾为同样的失证风险写过 `archive/ooo-continuation-2026-09-14/README.md`，但该经验没有保留到本次 session。`ooo-arms-pilot-2026-09-18.md` 中 D/E 和 cap experiment 所引用的样本现已纳入仓库。A/B/C 有汇总结果，但其逐次运行样本未保存在此处；下文会说明这一范围限制。

**运行内容。** 两个入口都要求 provider `deepseek`、model `deepseek-v4-flash` 与 `--live`。每次运行的独立报告均逐字保存，运行后没有编辑。

| 目录 | 入口 | 运行数 | 内容 |
| --- | --- | --- | --- |
| `fusion-darm/` | `plan-driver.ts run --session-runner` | 6 | D arm：`fusion.unitsPerSession` 为 1（对照）与 2（fused），各 3 次重复 |
| `fusion-darm/spec-1.json` | — | — | 对照 arm 使用的 spec（bound 1），包含冻结的 envelope 限制 |
| `fusion-darm/spec-2.json` | — | — | fused arm 使用的 spec（bound 2）；与 `spec-1` 只有该 bound 不同 |
| `fusion-darm/aggregate.json` | `node .temp/run-darm.mjs` | — | 六次运行及各 arm 的中位数；正文引用这些数据 |
| `smoke/` | `plan-driver.ts run --session-runner` | 4 | 机制 smoke：一个 session 运行两个 unit，以及最初失败的运行 |
| `speculation-earm/` | `evals/ooo-execution/speculation-pilot.ts --live` | 8 | E arm：baseline 与 speculation 比较，事实为 true/false，各 2 次重复 |
| `speculation-earm/aggregate.json` | — | — | 八次运行及按（arm、fact）分组的汇总 |
| `speculation-earm/run2-2026-09-19T05-40-04/` | `evals/ooo-execution/speculation-pilot.ts --live`（3 次重复） | 9 | 第二次 E-arm 运行：每次尝试的 artifact bytes、检查所用 candidate tree、检查原始输出、逐次运行行、汇总，以及说明该目录属于 scratch 的 `CLEANABLE.md` |
| `harness-three-way.json` | `node .temp/p1-harness.mjs` | 6 | 必须先完成的 harness 验证：冻结 stub、fixture canned answer 与错误答案都经过同一检查 |

**缺失内容及其为何成为计划要求。** E arm 第一次运行没有保存 artifact bytes：`speculation-pilot.ts` 只返回 candidate verdict，失败时删除 candidate tree，因此无法追问那次报告中“四个已检查 candidate 的质量都为 false”究竟为何。工具已不再删除 tree；`docs/experiments/execution/ooo-arm-plan-2026-09-19.md` 规定后续运行必须在启动前保存的字段——artifact bytes、check output、exit code 与 frozen digest——使下一次付费运行能诊断问题，而无需再付一次钱。

**本目录要保留的规则。** 一次运行的证据必须与报告其数值的同一变更一起写到 Git 跟踪的位置，运行本身不得删除证据。`.temp/` 适合保存工作副本；某条记录赖以成立的结果不是 scratch。

**更正（2026-09-19，第二次运行取得证据后）。** 上一段报告了一个并不存在的缺陷。`artifactEnvelope` 支持两种合法形状：patch（`digest, files`）和 conclusion（`digest, kind, conclusion, summary, evidence, citations`）；E arm 首次运行的 harness 却把**所有** artifact 都交给只读 patch 的 `patchCandidate`。因此当时通过错误的 reader 报告了质量失败：第二次运行的 9 次尝试中有 8 次返回 conclusion artifact；这种 unit 的检查无法接受它，board 也会因同一原因拒绝。唯一一次 patch 尝试则有真实错误：它写了 `rows: [...]`，而冻结接口要求 `lines: [...]`。工具现在会按 artifact 类型选择 reader，并记录实际使用的 reader。

## `cap4-darm/`：cap experiment（2026-09-19）

检验离线 ceiling 对“一个 session 承载四个 unit 可节省约 5 700 ms”的预测。入口为 `aggregate.json`（按 bound 的中位数与实测节省）；四次运行分别是 `bound{1,4}-rep{1,2}.json`，两个 spec 为 `spec-{1,4}.json`。它们以 `evals/ooo-execution/fixtures/pipeline/fine.spec.json` 为基础，并移除了 canned answers，使各 unit 确实运行。测得节省 5 796 ms，对应预测 5 700 ms。早期非配对 token 读数为 1.3–1.9 倍；后续 cache accounting 已取代这项比较。

## `cap-cache/`：带 cache accounting 的 cap experiment（2026-09-19）

重新运行 cap experiment，并在 tokens 旁记录 cache reads，因为 chain 会传递 context，重发的大部分内容会由 cache 服务。入口为 `aggregate.json`。测得 cap 1 调至 cap 2 节省 8 753 ms（预测 3 800 ms，因此 startup 项取决于计划形状）；cap 2 以最少 tokens 占用了大部分可用 wall time。两次重复的 `tokens - cacheRead` 计数（7 925 / 7 942 / 9 142）最初被当作输入量稳定，但它们不能单独区分未缓存输入或计算价格；见下方更正。较早 `cap4-darm/` 的 token 倍数来自非配对中位数，已被取代。

## 后续说明（2026-09-19，写完此归档后）

在规划 A–D 对比时（[arm plan](../../ooo-arm-plan-2026-09-19.zh-CN.md)，P6），发现了对上文两项说法的更正。它们都不改变已保存的报告。

**“每个样本”的范围。** 上文的范围覆盖被挽救的 D、E 与 cap arms，不包括 A/B/C。arms 记录引用了它们的汇总（33 677、94 601、59 830 tokens），但这些逐次文件不在仓库、本目录或其他已知位置。coarse 与 slot arms 有摘要，没有全部样本。

**“Fresh input”是误称，“保持稳定”也没有测得。** `tokens - cacheRead` 是未由 cache 提供的 tokens；其中仍包含所有输出 tokens，而且报告没有说明 cache 数值是否包含在 total 中。cap 1 与 cap 2 的第三次重复还表明，该 cell 的 token spread（11 946）大于待比较的差值，所以原句中的稳定只是两次重复的读数，不是测量结论。它是计数，不是价格；计算价格需要分别记录 uncached input、cache reads 和 output。`cap-cache/aggregate.json` 已在其自身说明中记录此限制；对该列的后续解释已在[fusion planning 文档](../../../../design/ooo-fusion-planning.zh-CN.md)中更正。

## `cap-cache/` 第三次重复（2026-09-19，同日稍后）

[arm plan](../../ooo-arm-plan-2026-09-19.zh-CN.md) 要求 A–D cells 报告范围而非两点差距，因此 cap experiment 的 bound 1 与 bound 2 各补了一次重复。

- `bound1-rep3.json`：接受 4/4，parent accept，wall 25 270 ms，tokens 33 941，`cacheRead` 20 608。
- `bound2-rep3.json`：接受 4/4，parent accept，wall 17 427 ms，tokens 35 444，`cacheRead` 24 448，两个 sessions。该运行使用 `--session-runner`；`spec-2.json` 要求此参数，缺少时会拒绝 fused live continuation。
- `bound2-rep3-without-session-runner.json`：保留了该拒绝结果。driver 指出无法继续的 session，将其写入 `incomplete`，并在第一个 unit 后停止；根据 usage 行猜命令会多花 11 019 tokens，而不是产生一个错误测量。
- `aggregate-3rep.json`：使用所有已存报告重算两个 cell（cap 1、2 各三次；cap 4 仍为两次），不从正文复制数据。它是当前数值的入口；`aggregate.json` 保留原两次重复读数，其中位数（26 620 / 17 867 ms）加入第三次后变为 26 186 / 17 735 ms。

**来源信息与报告未记录的内容。** 报告含 spec、worker、model、envelope limits 与 session 分组；没有 instrument commit 或 prompt digest。外部可确认的时间如下：

| 运行 | `measuredAt`（UTC） | instrument |
| --- | --- | --- |
| cap 1、2、4 的第 1 与第 2 次重复 | 06:54:14–06:56:06 | 未记录；早于同日 12:11:24Z 的 chain-prompt 修复 commit `7004f971` |
| cap 1、2 的第 3 次重复及被拒绝的运行 | 12:32:22–12:33:06 | 修复之后、干净工作树的 `4b0ba09a` |

因此，每个 cell 的前两次重复在 spec 相同、同一天、相隔数分钟且只改变一个声明变量；第三次重复则是在 prompt 已变化后对同一 spec 的后续观测。节省不是该变化造成的：单看前两次，cap 1 的 26.2–27.1 秒与 cap 2 的 17.7–18.0 秒已分开。若每次运行都记录 commit 与 prompt digest，就不需要此表；在 driver 做到这一点之前，对比必须注明哪些运行共用一个 instrument 版本。

**第三次重复改变了什么。** wall saving 为 8 451 ms，相对 cell 内 spread 1 783 ms 与 571 ms，是一项明确速率。token 和 cache 列则无法作同样结论：cap 1 自身的 token spread（11 946）大于其与 cap 2 的中位数差（7 789），而单一 cell 内 cache-read 占 tokens 比例介于 0.607 与 0.847。因此“80–84% 的 tokens 来自 cache reads”只是两次重复造成的假象。cap 2 cell 的第三次运行还使用了较新的 chain prompt；在当天早些时候加入了 exclusivity 与 admitted-tools 行。故此处应将各次运行视为带日期的测量，而不是同一 instrument 版本。

## `granularity-abc/`：普通路径上的 A、B、C cells（2026-09-19）

每个 cell 如何比较——每对只改变一个声明字段、读数采用何种等级、何时 spread 表示样本无法区分效应——由[测量计划](../../ooo-arm-plan-2026-09-19.zh-CN.md#p6---测量计划：每个-cell-用途及比较规则)拥有。每个 cell 的计算结果及配对信息存于 [`matrix.json`](matrix.json)。

为完成 review 要求的 same-parent 对比而运行；此前 cap experiment 自身的 cell 并非 B cell：三个 cap specs 都声明了 `fusion`（bound 1、2、4），因此即使 bound 为 1，也全部运行在 **chain surface** 上——每个 slot 一个 session、放宽的 artifact schema、chain prompt。于是 `cap 1` 是融合 arms 的同表面对照，不是普通未融合 arm；必须在普通路径上运行 A、B、C 才能比较粒度。

`spec-a.json` 是 `fixtures/pipeline/coarse.spec.json`（整个 pipeline 为一个 unit）；`spec-b.json` 是 `fixtures/pipeline/fine.spec.json`（四个 unit）。两者都移除了 fixture 的 canned answers，并替换为 cap experiment 的 worker 和 envelope：`pi`/`deepseek-v4-flash`、`turns: 6`、`reads: 3`、`timeoutMs: 120 000`、相同 fixture baselines 与 parent check。C 使用 `spec-b.json` 加 `--slots 2`。构建脚本会拒绝非离线 canned fixture、已声明 fusion 的 fixture、缺失 provider/model、已存在的 spec 文件，以及 unit 数量不符合比较要求的 cell。

随后于 2026-09-19，A、B、C 各追加一次重复（`b-rep2.json`、`c-rep2.json` 分别为 30 178 和 30 472 tokens），使 B/C 从一次观测变为一对，满足 plan 对 Q2/Q3 的评级要求。每次运行一个重复；有两次重复的 cell 以下报告中位数。

| arm | 形状 | slots | 重复数 | wall | wall 中位数 | tokens | tokens 中位数 | input | output | cache read | provider cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | coarse，1 unit | 1 | 1 | 9 726 ms | 9 726 ms | 9 018 | 9 018 | 2 377 | 1 521 | 5 120 | 0.000773 |
| B | fine，4 units | 1 | 2 | 21 885 / 23 273 | 22 579 ms | 29 962 / 30 178 | 30 070 | 8 940 / 7 248 | 3 230 / 3 346 | 17 792 / 19 584 | 0.002206 / 0.002006 |
| C | fine，4 units | 2 | 2 | 18 565 / 19 336 | 18 950 ms | 30 674 / 30 472 | 30 573 | 7 238 / 3 813 | 3 596 / 3 491 | 19 840 / 23 168 | 0.002076 / 0.001576 |

每个 unit 都被接受，每个 parent check 都接受，`slotsUsed` 等于请求槽数。报告为同目录下的 `a-rep1.json`、`b-rep1.json`、`b-rep2.json`、`c-rep1.json`、`c-rep2.json`，并有 `aggregate.json` 和计算后的 [`matrix.json`](matrix.json)。这些是首批包含 usage 拆分与 instrument 信息的运行：

- `tokens` 精确等于 `input + output + cacheRead + cacheWrite`（A：2 377 + 1 521 + 5 120 = 9 018），因此 cap experiment 尚只能推测的列现在可以拆分，并附有 provider 自己报告的 `cost`。
- 每个 unit 都记录了 `promptDigest`：A 的一个 unit 与 B 的四个 unit 各有独立摘要。这证明普通路径给每个 unit 使用全新 strict prompt，也解释了为何 chain 必须另行论证。
- 前三次运行的 `instrument.commit` 为 `f1583087656383c56f90c9288b9ec0d60eb17cf8`：instrument 已写入但尚未 commit，因此 HEAD 仍指向前一 commit；后两次为 `19dbc72199ff54588554fcbf5527cc9cc086ceab`。两者差异仅为一条命令：`git diff --stat f1583087..19dbc721 -- evals/ooo-execution/plan-driver.ts src/integration/ooo-session-mechanism.ts .pi/extensions/nmg/ooo-execution.ts` 显示 135 insertions、36 deletions，恰好是 instrument commit `9803ce7a`，没有其他改动，因此同一 cell 的两次重复使用相同执行代码。更早同日的 cap cells 没有记录 commit。

**两种路径的成本：实测。** B 和 `cap 1` 是同一计划、相同槽数、但处于不同 surface：B 的中位数为 22 579 ms，cap 1 为 26 186 ms；tokens 分别为 30 070 与 45 482，差值为 3 607 ms 与 15 412 tokens。按 plan 的等级规则，3 607 ms 对比阈值 `2 × 1 783 ms`，只高出 41 ms，刚好达到 pair grade——这是矩阵中最窄的读数。因此 bound=1、什么也不融合的 fusion 声明并非免费：chain surface 每次 turn 都重新发送与读取 context。token 差值未达到区分阈值（15 412 对 spread 11 946），因为 cap 报告没有 usage 拆分。相较两个基线，fusion 仍更快：`cap 2` 中位数 17 735 ms，比普通 B 少 4 844 ms，比 cap 1 少 8 451 ms，但比 B 多花 7 623 tokens。这个成本差仍未定价：已存 cap 报告是在 usage 拆分存在前记录的，没有 `input`/`output`/`cost`；而失败形状在三次运行时也未能被定价。
