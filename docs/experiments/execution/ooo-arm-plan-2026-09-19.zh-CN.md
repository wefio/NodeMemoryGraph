# Arm 计划：项目剩余事项及各步骤所需数据

[English](ooo-arm-plan-2026-09-19.md) · [术语](ooo-arm-plan-2026-09-19.terms.yaml)

**状态：**历史计划，于 2026-09-19 关闭；不授权再次运行。编写本计划时，arms 记录引用的一些付费运行证据已被删除或从未持久化。后续[归档](./archive/ooo-arms-2026-09-19/README.zh-CN.md)保存了 D/E 与 cap 报告；A/B/C 仍只有汇总。

**相关文档：**[arms 记录](./ooo-arms-pilot-2026-09-18.zh-CN.md) ·
[找回的样本](./archive/ooo-arms-2026-09-19/README.zh-CN.md) ·
[义务台账](../../design/task-unit-semantics-obligations.zh-CN.md)

## 本计划要遵守的规则

每个步骤只有在数据清单固定后才能运行：收集哪些字段、写到哪里、如何解释。工作中的文件可暂存在 `.temp/`；报告提出主张前，支持主张的字段必须复制到 Git 跟踪的 `docs/experiments/execution/archive/<run>/`。运行不得删除自己的证据；`.temp/` 只放工作副本。G7 与 D/E 归档记录了促使 P4 增加显式清理标记的证据保留问题。

## P1：为什么所有已发布 candidate 都没通过自身检查？（离线；一个 unit；约 11k tokens）

**问题。** E arm 首次运行对四个已验证 candidate 都报告 `quality: false`；按设计规则，这不能支持任何收益主张。由于该运行没有保存 bytes，报告无法指导后续行动。

**收集数据。** 经 `evals/ooo-execution/speculation-pilot.ts` 进行一次全新尝试；每次尝试写入：`artifactId`（artifact bytes 的 sha256）、`artifactPath`、`candidatePath`（保留的 tree）、`checkStdout`、`checkStderr`、`checkExit`、`checkMs`、`frozenDigest`、`interfaceDigest`、`tokens`、`turns`、`workMs`、`instruction`。

**分析。** 使用同一检查手动运行并对比三项：冻结 stub、模型 candidate、fixture 自带的 canned answer（已知正确），再比较 candidate 与 stub 的 diff。

**判定。** 看表本身。若 canned answer 通过而模型答案失败，则 `quality: false` 是模型工作的结果——未验证的猜测产生了坏 patch；arm 的下一个问题应是验证，而不是 harness。若 canned answer 也失败，则 harness 有缺陷，不能从首次运行得出其他结论。

## P2：E arm 的经济性（付费；最多 150k tokens；每种条件重复 3 次）

**收集数据。** P1 的全部字段，加上 `arm`（baseline | speculation）、`fact`（true | false）、`rep`、`outcome`（来自 `speculationOutcome`）、`sessionReusable`、`ticketId`、`sessionId`、`reusedSession`、`verifyMs`、`postFactMs`、`wasteTokens`（fact 最终为 false 时 speculation 的支出）。按（arm、fact）报告中位数和范围，不能只报一次运行。

**分析。** 将设计的三项成本分开，不合并成净值：fact 成立时节省的延迟、fact 不成立时浪费的 tokens、每个已发布 candidate 的质量项。根据测量值计算盈亏平衡命中率 `p* = waste / (saved + waste)`，并报告阈值与样本数。

**判定。** 对比 cell 内质量相同是前提，不是结果：若已发布 candidate 未通过检查，arm 就报告该结果，不声称加速。否则，只需一个 cell 中出现已通过验证的已发布 candidate，且包含验证的 fact 后延迟低于对照的 fact 后工作耗时，即可确认可行性。命中率阈值就是分析结果，无需为写出阈值再付费。

## P3：关闭——首次运行的 envelope 诊断有误（2026-09-19）

E arm 首次运行报告怀疑 extension 接受了 conclusion artifact，但 host 的 `patchCandidate` 拒绝它。第二次运行取得证据后更正了这一读法：`artifactEnvelope` 同时支持 patch 与 conclusion 两种形状，但 harness 把所有 artifact 都交给只处理 patch 的 reader。正确修复是按 artifact kind 选择 reader 并保留证据，不是拒绝合法 conclusion 或放宽 envelope。原 P3 的 acceptance-matrix 计划因此不适用；adapter/host 实际不存在 envelope 不匹配。更正记录于[arms 报告](./ooo-arms-pilot-2026-09-18.zh-CN.md)、[台账](../../design/task-unit-semantics-obligations.zh-CN.md)与[归档](./archive/ooo-arms-2026-09-19/README.zh-CN.md)。

## P1 与 P2：已回答（2026-09-19）

诊断见归档 README 与 arms 记录：9 次尝试中有 8 次产生 conclusion artifact；唯一的 patch 写成 `rows` 而非 `lines`；没有 envelope 缺陷，问题是工具使用了错误的 reader。经济性已测量：成本真实、收益未实现（fact 成立的 3 次重复中有 0 个可发布 candidate），约束在 candidate 是否可接受。

## P5：成本模型拟合——尝试使用 autodiff，但结果不是 planner（2026-09-19）

设计把 autodiff 指定为“成本或动作评分”的复用目标，arms 也需要成本模型而非声明式上限，因此用 `src/lab/autodiff.ts` 对付费运行做了拟合：对所有行执行一次 stacked design-matrix matmul（不是逐次运行构建子图；早期工作快 9.6 倍），不编译 tape（一次性拟合无法摊销其 O(graph) 编译成本），对 feature 与 target 标准化，使用普通 gradient descent。

**结果：拟合不构成模型。** 19 次付费运行的 leave-one-out residual 为 −15 955 至 +11 805 tokens，而平均值是 11 184；它无法预测未见过的行。拟合出的 session-startup 项为 **0 ms**，而 D arm 直接测得约 1 900 ms。这更有用的发现是：这些运行无法识别该项，因为 D arm 将 `units` 固定为 2（bound 1 = 2 sessions，bound 2 = 1 session），导致 `units` 与 intercept 共线，且每个水平只有三次运行。

**阻塞点在数据，不在 optimizer。** 当时提出的下一步不是改进拟合，而是改进 design matrix，并先做成本较低的离线阶段：

1. 使用 canned workers（不调用模型），针对每 session 的 unit 数 1、2、3 构建设计矩阵，让 `units` 变化；只有两个 feature 独立变化，session 项才可能估计。
2. 记录可能携带信号的 feature，因为单个 arm 内的测量 spread 大于 arms 间差异：union tool surface 自身的 token 数（每个 turn 都要付费，D arm 第一个 unit 多约 0.7k）、turns、snapshot 大小及每 unit tokens。
3. 用相同 autodiff 调用重新拟合，并再次报告 leave-one-out residual。只有 confidence interval 不包含零的项才能进入 planner。

**持续约束。** Autodiff 只给**合法**选项定价，不能决定合法性。两个 unit 能否共享 session 仍是对声明事实的谓词（`sharedSessionLegal`），任何拟合数值都不能扩大它。上述 follow-up matrix 未运行；arm 项目在下方关闭，没有产出 planner 拟合或通用成本模型。

## P6：测量计划——每个 cell 的用途及比较方式

本节是计划，也是 arm 项目测量规则的唯一 owner。其他文档应链接到这里，不重复规则。表格依据已存报告，而非摘要生成：`.temp/arm-matrix.py` 读取每个归档报告；若报告缺失或其 token 总数不等于四部分之和就拒绝；然后把 [`matrix.json`](archive/ooo-arms-2026-09-19/matrix.json) 写到报告旁边。

### 问题及其对应决策

| 问题 | 要观察什么 | 影响哪个决策 |
| --- | --- | --- |
| Q1 | 粒度：同一 parent task 下，一个 coarse unit 对比四个 fine units | 是否提供 fine plan 拆分 |
| Q2 | slots：普通路径上增加第二个并发槽 | slot budget 默认值 |
| Q3 | surface：session 只承载一个 unit、没有融合时，声明 fusion 的成本 | chain surface 是否默认进入，还是只有请求 fusion 时才进入 |
| Q4 | fusion：两个 unit 的 chain 与同 surface 对照以及普通路径比较 | 是否提供 fusion |
| Q5 | 长度：四单元 chain 对比双单元 chain | 声明 bound 的默认值 |
| Q6 | 价格：每个 arm 每次重复的货币成本 | 何时值得购买 fusion |
| Q7 | speculation：提前准备猜测是否划算 | 是否提供 E arm |

### Cells

两个 surface 上共八个 cell。Surface 是 cell 身份的一部分，不是细节：普通 cell 每个 unit 调用一次 worker；chain cell 使用一个 session，并通过 `patchSessionInput` 逐轮提交 artifact。因此不能把普通与 chain cell 当作同一条件。

| Cell | 对应问题 | Surface | 形状 | Slots | Bound |
| --- | --- | --- | --- | --- | --- |
| A | Q1 | plain | coarse，1 unit | 1 | - |
| B | Q1、Q2、Q3、Q4 | plain | fine，4 units | 1 | - |
| C | Q2 | plain | fine，4 units | 2 | - |
| cap1 | Q3、Q4 | chain | fine，4 units | 1 | 1（surface 对照） |
| cap2 | Q4、Q5 | chain | fine，4 units | 1 | 2 |
| cap4 | Q5 | chain | fine，4 units | 1 | 4 |
| D1 | Q4（pilot 自身的形状） | plain | pilot，2 units | 1 | - |
| D2 | Q4（pilot 自身的形状） | chain | pilot，2 units | 1 | 2 |

| Cell | Surface | 形状 | Slots | Bound | 重复数 | 每次 wall（ms） | Wall 中位数 | 每次 tokens | Tokens 中位数 | 每次成本 | 接受 | Instrument |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | plain | coarse，1 unit | 1 | - | 1 | 9726 | 9726 | 9018 | 9018 | 0.000773 | 全部 | f1583087 |
| B | plain | fine，4 units | 1 | - | 2 | 21885 / 23273 | 22579 | 29962 / 30178 | 30070 | 0.002206 / 0.002006 | 全部 | 19dbc721、f1583087 |
| C | plain | fine，4 units | 2 | - | 2 | 18565 / 19336 | 18950 | 30674 / 30472 | 30573 | 0.002076 / 0.001576 | 全部 | 19dbc721、f1583087 |
| cap1 | chain | fine，4 units | 1 | 1 | 3 | 26186 / 27053 / 25270 | 26186 | 45482 / 45887 / 33941 | 45482 | n/a ×3 | 全部 | none |
| cap2 | chain | fine，4 units | 1 | 2 | 3 | 17735 / 17998 / 17427 | 17735 | 41806 / 37693 / 35444 | 37693 | n/a ×3 | 全部 | none |
| cap4 | chain | fine，4 units | 1 | 4 | 2 | 16480 / 16810 | 16645 | 54834 / 55738 | 55286 | n/a ×2 | 全部 | none |
| D1 | plain | pilot，2 units | 1 | - | 3 | 11902 / 12948 / 14066 | 12948 | 22498 / 22435 / 22922 | 22498 | n/a ×3 | 全部 | none |
| D2 | chain | pilot，2 units | 1 | 2 | 3 | 11812 / 9584 / 11048 | 11048 | 22533 / 17592 / 26299 | 22533 | n/a ×3 | 全部 | none |

### 配对与各自支持的读数

一对只允许有一个声明字段不同。`cap1` 位于 chain surface，因此 `B vs cap1` 变化的是 surface；`cap1 vs cap2` 则在同一个 surface 上改变 fusion。Fusion 结论取后一组，不取 fused cell 与 plain cell 的比较。

| 配对 | 唯一不同字段 | 每次 wall 值 | Wall 中位数差 | Wall spread | Wall 等级 | Token 中位数差 | Token spread | 中位成本（左 / 右） | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A vs B | plan 形状（1 unit vs 4） | A 9726；B 21885 / 23273 | 12853 ms | 1388 ms | 单次观测 | 21052 | 216 | 0.000773 / 0.002106 | wall 单次观测分离（需超过 5 × 1388 = 6940 ms）；tokens 分离 |
| B vs C | slots（1 vs 2） | B 21885 / 23273；C 18565 / 19336 | 3628 ms | 1388 ms | 配对 | 503 | 216 | 0.002106 / 0.001826 | wall 配对分离（需超过 2 × 1388 = 2776 ms）；tokens 分离 |
| B vs cap1 | surface（plain vs chain，bound 1） | B 21885 / 23273；cap1 26186 / 27053 / 25270 | 3607 ms | 1783 ms | 配对 | 15412 | 11946 | n/a | wall 配对分离（需超过 2 × 1783 = 3566 ms）；tokens 无法区分 |
| cap1 vs cap2 | fusion bound（1 vs 2） | cap1 26186 / 27053 / 25270；cap2 17735 / 17998 / 17427 | 8451 ms | 1783 ms | 速率 | 7789 | 11946 | n/a | wall 速率分离（需超过 1 × 1783 = 1783 ms）；tokens 无法区分 |
| cap2 vs cap4 | fusion bound（2 vs 4） | cap2 17735 / 17998 / 17427；cap4 16480 / 16810 | 1090 ms | 571 ms | 配对 | 17593 | 6362 | n/a | wall 配对无法区分（需超过 2 × 571 = 1142 ms）；tokens 分离 |
| D1 vs D2 | fusion bound（1 vs 2），pilot 形状 | D1 11902 / 12948 / 14066；D2 11812 / 9584 / 11048 | 1900 ms | 2228 ms | 速率 | 35 | 8707 | n/a | wall 速率无法区分（需超过 1 × 2228 = 2228 ms）；tokens 无法区分 |

### Cell 的比较规则

1. **每对只改变一个声明字段**，且两个 spec 只有该字段不同。一次改变两项的配对是把两个读数伪装成一个。
2. **使用同一 instrument，否则明确说明。** 每份报告记录执行它的 commit（`instrument.commit`），并记录每个 unit 的 `promptDigest`。只有 commit 一致时，才能把两次运行当成同一条件；否则它们是相同 spec 的两次观测，报告必须注明。Spec 相同不代表执行条件相同。
3. **先看 wall，再看 tokens，绝不混合。** `wallMs` 是运行自身的 wall；`hostMs` 是 host 串行检查时间，单独报告，因为所有 arms 的 host 时间都串行。
4. **差值按等级判定，不做二元判断。** 一次重复是_单次观测_，两次是_配对_，三次或更多是_速率_。只有速率等级可用 spread 规则（差值大于较大 cell 自身 spread）判断是否分离；配对或单次观测必须分别超过较大 spread 的两倍或五倍。这就是 Q1 的 12 159 ms 在零 spread 的单次配对上可读，而 Q2 的 3 320 ms 不可读的原因。
5. **Spread 大于差值，表示样本无法区分效应，**而不是效应不存在。D1 vs D2 正是这种情况，且按 pilot 声明的等级判断。
6. **只有每个 unit 和 parent check 都接受、`failures: 0` 且 `slotsUsed` 等于该 cell 槽数时，cell 才计入比较。** 被拒绝或不完整的运行要归档并注明，从比较中排除，不通过重试替换。
7. **成本按 provider 自身价格**（每次运行的 `cost`）统计，不能用 tokens 估算：`tokens` 把 input 和 output 合在一起，因此 `tokens - cacheRead` 不是计费 input 的下界；发现后已更名。
8. **按每次运行配对汇总。** 排序数组仅用于算中位数；wall、tokens、cache reads 不得各自独立排序后按位置配对。
9. **运行不欠 gates；代码变更则欠所有适用 gates。** 这些运行不改代码，因此从干净工作树开始，计划之后无需测试通过；保护条件是树干净（报告 commit 指向实际执行代码）及记录的 instrument，规则 2 会读取这些信息。编辑 driver 或共享机制属于另一类工作：下一次比较前必须先运行该路径的阻塞检查，因为本项目已经记录过一次读错工作树的失败模式。

### 哪些情况刻意不作为 cell，以及原因

- **Coarse plan 使用两个槽。** 一个 unit 对应一个 claim，因此第二个槽无事可重叠；该 cell 测的是 scheduler，不是 plan。
- **Fine plan 使用三或四个槽。** 声明式槽预算规定一次 run 持有一个 claim；C 表明第二个槽有效，配对读数节省 3 628 ms。扩展槽数是另一个问题，需要不同工具。
- **第三个 bound（cap 3）。** 默认值需要方向；方向在 1 与 2 之间。增加 2 与 4 之间的 cell 只会细化无人据此行动的假设。
- **用 fused cell 与 plain cell 比较 fusion。** 这对同时改变 fusion 与 surface；会报告，但不能作为 fusion 读数。
- **带价格的 fused cell（Q6）**及**其他形状的付费 E arm（Q7）**：见最终状态。

### 最终状态

当上述每个问题都达到其决策所需的等级，或已注明原因关闭时，计划即完成。截至 2026-09-19，计划已关闭，不是待办。操作方当天关闭了项目；这些 cell 支持的分类是：在此任务形状下，coarse arm 最快；fine 粒度增加开销，第二个 slot 与 fusion 各自收回其中一部分（已观测）；在 chain 路径内，bound 2 胜过 bound 1（有重复，达到速率等级）；chain 路径自身成本、默认 bound、普遍成本收益关系仍未确定；证据足以指导下一步，不再购买样本。决定一次 run 何时可进入 chain path 的规则见[对应决策](../../decisions/implemented/2026-09-19-when-the-chain-path-may-be-entered.zh-CN.md)。

- **已回答。** Q1（12 853 ms，对照阈值 6 940 ms，单次观测等级）；Q2（3 628 ms，对照 2 776 ms，配对等级；C 的中位价格也低于 B，为 0.001826 对 0.002106，因此这组配对里第二个 slot 更快也更便宜）；Q3（3 607 ms 对 3 566 ms 阈值，同一 plan 与槽数；只多 41 ms，边缘性本身也是读数的一部分）；Q4（8 451 ms，速率等级，是两边都有三次重复的唯一配对）。
- **是一个假设，不是策略。** Q5：配对等级差值 1 090 ms，小于 1 142 ms 阈值，因此规则判定无法区分，也没有决策依赖该差值。它的 token 列在两次重复下超过阈值（17 593 对 12 724），但相关 cell 的 token spread 达到 11 946，所以只记录、不据此行动。
- **因理由明确而关闭，未测量。** Q6：已存 cap 报告没有价格拆分；三次运行都失败的形状只跑一次也无法定价，因此 fusion 成本仍是定性描述，所有文档在此状态下都写 `unpriced`。Q7：E arm 工具只运行一种形状，测得的是有成本而无收益，没有安排其他形状。
- **没有待办。** 此处曾列为选项的配对确认当天已购买，共 60 650 tokens——B 第二次重复 30 178、C 第二次重复 30 472——并按上述结果解决 Q1、Q2、Q3。本计划没有未运行 cell；这些数字的下一步若有，是**决策**（声明策略），不是再测一次。

### 支出

共购买三批运行，每批遵循同一规则：只有用户为该步骤指定上限后才能付费；此计划不再购买其他 cell。Cap cells 第三次重复花费 80 404 tokens，A/B/C 花费 69 654，配对等级确认花费 60 650；此项目共 210 708。此前 fusion pilot 约 75k，E arm 约 43k。运行失败就按失败报告，不重试；fused spec 不能当作 unfused 对照运行，因为 driver 会拒绝。

## P4：轻量保留（免费）

用户对此的理解记录于此，作为后续规则：工作进行时就需要运行证据，因此写入带清理标记的 scratch 目录（`.temp/.../CLEANABLE.md`）；只有所需证据复制到受 Git 跟踪的归档后，scratch 才可删除。问题不在 scratch 存在，而在记录所需数据写入前就删除了数据。工具会写出每个 artifact、candidate tree 与检查输出，标记目录可清理，并在记录引用运行结果前将运行复制到受跟踪的归档。无需 `docs:check` 规则：这里需要的是保存证据的位置，不是 gate。
