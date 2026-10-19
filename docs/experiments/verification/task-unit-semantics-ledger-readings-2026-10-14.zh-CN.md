# 历史上的任务单元账本验证读数

[English](task-unit-semantics-ledger-readings-2026-10-14.md) | [简体中文](task-unit-semantics-ledger-readings-2026-10-14.zh-CN.md) · [术语](task-unit-semantics-ledger-readings-2026-10-14.terms.yaml)

**Source:** 历史读数原从[义务账本](../../design/task-unit-semantics-obligations.zh-CN.md)于 `270d9e3bbaa0548b17ee996a2261253e3fce841a` 搬移。它是搬移来源，不是所有观察共用的 run／tree 身份。本版增加阅读范围说明，没有重跑旧通过。

## 阅读历史仪器

下列命令、计数、时间、失败及后续修复均属于所标检查点。重复总数不证明同次运行或独立
重复；不同 register／套件布局不是配对加速试验，路径 selector 数也不自动等于还原文件数。
本轮未重开原始产物。原文建议重跑，不是今天的运行指令或批准；当前操作归
[开发 Skill](../../../skills/repo-development/SKILL.zh-CN.md)。旧的“harness 不写日志文件”
不能概括全部读数：2026-09-19 条目明确报告结束时 JSON 在 stdout 丢失后仍存在；JSON
存在或历史退出码都不是新回执。

## 早期模型与研究 driver 读数

- `node --experimental-strip-types --test evals/ooo-execution/cost-model.test.ts` -> 8 pass, 0 fail, exit 0（F1：该模型的性质，包括不能加入质量项）
- `evals/ooo-execution/round-plan.test.ts` 于 2026-09-18 随轮次一同退役（[决策](../../decisions/implemented/2026-09-18-retire-the-round-instrument.md)）：它的性质（一轮的日志点名它所得到的计划）没有产品对应物，因为日志本身就是该仪器的产物
- `node --experimental-strip-types --test evals/ooo-execution/narrow-dispatch.test.ts` -> 6 pass, 0 fail, exit 0（F2b-slot：已声明的预算被在途 claim 花掉、已被 claim 的任务不再可选、预算削减起点而不削减有序集合、被 claim 的依赖仍然阻塞，以及零或半个槽位被拒绝）
- `node --experimental-strip-types --test evals/ooo-execution/board-slots.test.ts` -> 3 pass, 0 fail, exit 0（F2b-slot：同时持有两个 claim 并以 store 自身的 `serialState`／`to` 作为理由、默认许可为队首，以及一次验收在另一槽位被持有时释放了某个依赖项）
- `node --experimental-strip-types --test evals/ooo-execution/plan-driver.test.ts` -> 8 pass, 0 fail, exit 0（F2b／F2b-slot：计划顺序、在 claim 时间上重叠的情况下达到已声明槽位数、依赖、worker 失败、父检查、在未达到槽位数时该比较拒绝给出时间裁决，以及——由退役过程加入——当一个独立单元的 worker 在运行时，某单元的检查仍未完成，这由已登记的 mutant `the-driver-awaits-each-unit-instead-of-the-batch` 抓到）
- `node --experimental-strip-types --test evals/ooo-execution/families.test.ts` -> 8 pass, 0 fail, exit 0（F2c／F3：两个任务族，各自在单槽位与双槽位下粗粒度计划与细粒度计划都被接受、一个错误答案被自己的检查拒绝并连带毁掉该 composition，以及一个没有任何检查的单元被点名拒绝）。1.3 s：每次验收都是对候选文件的真实检查，且自[数据检查决策](../../decisions/implemented/2026-09-20-tests-need-no-filesystem.md)以来它是一个在内存中评估的 fixture 测试文件，而不是在每单元 git worktree 中跑 `node --test`；在那种 worktree 还存在时，同样的 8 个用例耗约 30 s，那是展示该任务族可行的代价
- `node --experimental-strip-types --test --test-concurrency=4 "evals/ooo-execution/"*.test.ts` -> 93 pass, 0 fail, exit 0（轮次的八个套件随它退役后为 11 个套件；该计数取自退役过程，存活的套件未变）
## 产品时钟边界回归

- `npm run test:product` -> 1457 pass, 0 fail, exit 0。**这一行原本是「一次完整运行在并行负载下先报告一次失败，重跑又以 1433/1433 通过；记为 flaky，未修复」——那个标签是错的，而且它掩盖了一个产品缺陷。** 该失败是 `demoteMemory: demotes LTG memory to STG`，且它是一个时钟边界：一条以 `valid_from` 写在读取连接 `strftime('now')`_之后_一小会儿的记忆被读作非当前（在 3000 次写后读轮次中测得 2 次，时间戳 `…38.468Z` 对 `now` `…38.467Z`）。通过在 `src/core/store/clock.ts` 中命名的宽限修复，由 `tests/core/store/current-value-window.test.ts`（6 个用例）与 4 个命名 mutant 钉住，在[时钟宽限记录](../../decisions/implemented/2026-09-18-clock-grace-window.md)中决策，作为[事后分析 0004](../../postmortem/0004-flaky-was-a-clock-boundary.md)记录。计数随修复的窗口与之后新增的用例从 1446 移到 1457
## 2026-09-19 多 worktree sweep 与后续修复

- `npm run mutation:teeth` -> 136/136 caught by the named test, 20/20 targets restored byte-identically, exit 0。于 2026-09-19 以四条 lane 运行，每棵树一次 sweep，其中三条用 `git worktree add --detach` 在同一提交上创建：一次 sweep 在**一棵树内**是串行的，因为它的 mutant 替换同一个文件，而跨树并行，在那里每条 lane 还获得隔离性质——不同 worktree 的本地目标文件分开；这不自动隔离共享绝对路径、缓存或服务。Lane 为：42/42（`ooo-board`、`task-coordinator`）、41/41（`base`、`ooo-execution` 的 17 个、`task-semantics-interleavings`）、42/42（十三个小 target）与 11/11（`plan-driver`）——最后一个被串行进自己的 lane，因为它的套件有一个 25 s 的用例且做真实的候选验证（每次运行约 92 s，而廉价套件约 2 s）。**那条 lane 的成本此后已经改变**：两臂的检查现在是数据检查，因此在 `c01d3fe` 上它的干净运行是 5.5 s，它的五个 mutant 在同一 target 上于 0.8-1.2 s 内被各自点名的用例抓到；本段中的数字描述的是 2026-09-19 的那件仪器。

### 所报 harness 失败与修复

记录报告三个后续修复：

-锁的 `live` 标志在替换时从未被写入（一次多 hunk 编辑整体失败，只有恢复的那一半被重新应用），因此该字段对运行中的 sweep 撒谎；
- 当 sweep 从 `node --test` 进程内部启动时 `NODE_TEST_CONTEXT` 被继承，使嵌套 runner 在完全没跑测试的情况下以 0 退出，而 harness 把它报告为「套件通过」，这让该 target 的每个 mutant 都变成虚假的「未抓到」；
- `agent:verify` 中的拒绝在 `--dry-run` 时也触发，导致 verifier 自己的两个测试在 sweep 持有该树时失败（dry run 读的是计划与路由配置，不是被改动的文件，因此现在被豁免）。

报告了干净运行失败的那条 lane（`tools/agent-verify.ts`）发现了三者中的最后一个。只要存在任何锁，sweep 也会被拒绝，包括所有者已死的锁，因为被杀的 sweep 可能把它的 mutant 留在 target 中（事后分析 0003）。

### 中断与结果产物

中断说明：两个 lane 进程被启动它们的控制台杀掉并重新启动；每次运行在结束时写入的 JSON 即使在缓冲的 stdout 摘要丢失时也存活下来，因此上面的 lane 结果是从那些文件读出的，而不是从 stdout。

### 后续 register 变化与操作 owner

（退役过程加入了 driver 的 interleaving mutant；在本次过程之前是 111/111：`src/integration/task-semantics-interleavings.ts` 增加了三个预算 mutant，`evals/ooo-execution/plan-driver.ts` 增加了三个，分别对应每单元检查、罐装 worker 与父 composition）。这些运行如何排期（变更期间用 scoped、推送前用 full、detached 并收集结果）现在是仓库的常设规则，位于 [`skills/repo-development/SKILL.md`](../../../skills/repo-development/SKILL.md)，其实测成本在[决策](../../decisions/implemented/2026-09-18-detached-long-checks.md)中
## 历史复杂度基线

- `npm run complexity:gate` -> exit 0，18 个方法超过 15，与基线相比未变。它抓到的是 E 过程的第一版（加入 advisers 选项把 `BoardAdmission` 的构造函数推到 17，于是选项检查被移进 `admissionAdvice()`），而不是阈值被抬高；槽位过程以同样方式加入了它的选项检查（`admissionSlots`），而 ordered-set／`publishReady` 的读取仍在其下
## 2026-09-24 锚点与变化的 mutation register

所报定位成功、套件失败、点名用例失败及超时是不同证据。下文被计为抓到的 30 s 超时不是
已完成的语义断言；须保留该限定，不能把标题读成每个故障均由预期断言独立证实。

- `node --experimental-strip-types --test tests/tools/mutation-anchor.test.ts` -> 16 pass, 0 fail, exit 0（2026-09-24：解析器的六个操作符及其拒绝，针对源码字符串，不碰文件系统）
- `npm run mutation:teeth -- --anchors-only` -> `anchors: 149 of 149 resolve, over 23 targets`，exit 0，0.6 s 内（2026-09-24：每个 tooth 仍适用于它瞄准的位置；有一个 anchor 通过空白归一化重新取得，`the-completion-does-not-bind-the-verdict-to-the-bytes`）
- `npm run mutation:teeth -- --anchors-only` -> `anchors: 144 of 144 resolve, over 23 targets`，exit 0，0.7 s 内（2026-09-24，在五个 teeth 被退役、改用已经陈述其规则的检查之后）
- `npm run mutation:teeth -- --targets=src/integration/ooo-board.ts` -> `mutants: 15 of 15 caught by the named test`，逐字节还原（2026-09-24，在那里又有六个 teeth 退役之后：五条预算／发布规则与 run-scoping 主张）
- `npm run mutation:teeth`（整个登记表）-> `mutants: 136 of 136 caught by the named test`，23/23 targets restored byte-identically，exit 0，217 s 内（2026-09-24），**其中每一个都是被其 `expect` 所点名的用例抓到**。第一次全登记表读数（231 s，按名抓到 134/136）暴露了三个错误链接，全部在同一次过程修复：`the-caller-rebuilds-the-shared-floor`（它的 `expect` 是对任何用例的转述，已重新指向）、`the-grace-is-zero`（它点名的用例从被测常量派生自己的 fixture，因此在缺陷存活时它仍然通过——fixture 现在是字面量），以及 `next-is-not-the-head-of-the-ordered-candidates`（重新指向 `at the default budget the licence is still the head of the ordered set`，该用例现在断言队首）。第四个由试点 sweep 发现并在此修复：`fusion-continues-from-an-unverified-answer` 的用例还以第二个理由拒绝了这对，因此它在 mutant 下通过——当两个单元之间没有依赖时，它只被那一个条件拒绝。有一行仍带一条说明而不是断言：`the-pass-asks-a-unit-it-already-failed-again` 被一个在其 30 s 界限内无法完成的点名用例抓到，本工具把它计为已抓到并打印该原因
- `npm run mutation:teeth`（整个登记表，每个 tooth 都派生）-> `mutants: 110 of 110 caught by the named test`，**全部 110 都由其 `expect` 所点名的用例抓到**，22/22 targets restored byte-identically，exit 0，160 s 内（2026-09-24）；`npm run mutation:anchors` -> `anchors: 110 of 110 resolve, over 22 targets`；`tests/tools/mutation-anchor.test.ts` -> 34 pass；`test:product` -> 1580 pass；`verify:static` exit 0；lint 0 findings；complexity gate ok
- `npm run mutation:teeth`（整个登记表，在加入目录所点名的操作符并再转换 18 个 teeth 之后）-> `mutants: 110 of 110 caught by the named test`，**全部 110 都由其 `expect` 所点名的用例抓到**，22/22 targets restored byte-identically，exit 0，176 s 内（2026-09-24）；`npm run mutation:anchors` -> `anchors: 110 of 110 resolve, over 22 targets`；`tests/tools/mutation-anchor.test.ts` -> 30 pass
- `npm run mutation:teeth`（整个登记表，在 59 个 teeth 被转换为派生选择器之后）-> `mutants: 110 of 110 caught by the named test`，**全部 110 都由其 `expect` 所点名的用例抓到**，22/22 targets restored byte-identically，exit 0，171 s 内（2026-09-24）。转换并不是让它们咬住的原因；它是让它们保持瞄准的原因：本次过程中发出过一个错误的 `within`，而 sweep 抓到了它——作为一个被套件而非被点明其规则的用例抓到的 tooth
- `npm run mutation:teeth`（整个登记表）-> `mutants: 110 of 110 caught by the named test`，22/22 targets restored byte-identically，exit 0，162 s 内（2026-09-24，在**又有 26 个 teeth 被退役**、改用已陈述其规则的检查之后——本次过程检查的 27 个 insertion 形态 teeth 中除 `every-task-is-frozen-at-position-zero` 之外全部如此，后者的点名用例是一次 register／freeze／adopt／read-back 往返，因而弱于该规则）。全部 110 都由其 `expect` 所点名的用例抓到。这 26 个中有七个最初被读作 **orphans**，因为没有行点名该 tooth：`round-publication-opens-its-own-transaction`、`round-never-releases-its-pin`、`ordered-mode-becomes-any-topological-order`、`the-loop-awaits-each-unit-instead-of-the-batch`、`a-unit-is-dispatched-twice-in-one-batch`、`a-unit-nothing-checks-is-still-a-unit` 与 `the-parent-check-ignores-its-own-verdict`。随后每条规则被给予一个归属地，而不是为它发明一个新的归属地：发布规则归 B3（取代它的用例在 B3 的套件中并陈述同一转换）、pin 释放是 B4 的另一面、ordered 模式是为它新增的 **A6** 行（它所实现的设计句子原本没有行），而四条 judge-loop 规则归 F2b-slot 与 F2c——批量规则与重复派发共用一个用例 `a unit's check is outstanding while an independent unit's worker runs`，而没有检查的单元与父检查是 F2c 现在点名的两个用例。每个用例所做的检查在[记录](../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md)中。target `tools/agent-verify.ts` 随它唯一的 tooth 一起消失
- `npm run mutation:teeth -- --targets=src/integration/ooo-board.ts,src/integration/ooo-execution.ts,src/integration/task-semantics-interleavings.ts,src/integration/task-coordinator.ts` -> `mutants: 70 of 70 caught by the named test`，restored byte-identically 5/5（2026-09-24，退役触及的四个 target）
- `npm run mutation:teeth -- --targets=src/integration/ooo-execution.ts` -> `mutants: 24 of 24 caught by the named test`，restored byte-identically 2/2（2026-09-24：转换后的试点文件，其 24 个 teeth 中 19 个是派生的；23 个被其 `expect` 所点名的用例抓到，1 个仅被套件抓到，即 stale 名称 `fusion-continues-from-an-unverified-answer`，转换既未造成它也未能修复它）
## 历史 static 与 LSP 范围

下述 tsconfig、路由、零诊断及 31 条诊断都属于记录快照，不是当前类型覆盖审计或预期总数。

- `npm run lint`（现在覆盖 `src/ .pi/extensions/ claude-plugins/ workbuddy-plugin/ tests/ evals/ scripts/ tools/`）-> 0 findings, exit 0；`npm run check` -> exit 0。对 `evals/` 下某路径运行 `npm run agent:verify` 仍会因评测路由针对被跳过的 LoCoMo bridge 的 TAP 规则而失败——按决策，该规则保留，且理由点名该跳过。**一个随 LSP 发现的注意事项，以及它现在的状态**：`evals/**` 不在任何 `tsconfig` 中，因此 `npm run check`／`check:tests` 从不类型检查它，只有 LSP 看到那些文件。本次过程记录到的诊断已于 2026-09-23 修复（两个证据 driver 的 flag 收窄、`live-continuation.ts` 声明的结果形状，以及 `tests/integration/ooo-evidence-drivers.test.ts` 的 `{ pid: 0 }` 兜底，提交 `e31fe776` 加上其旁边的测试修复），因此这条弧线触及的每个文件都报告零诊断：对它们的 LSP 读数——两个 driver、`live-continuation.ts`、store board 的测试与 `ooo-evidence-drivers.test.ts`——是零。`src/` 也是干净的，这一点由 `npm run check`（exit 0）覆盖。LSP 仍报告的是本条弧线不拥有的七个 `evals/` 文件中的 31 条诊断：`benchmarks/run.ts` 7、`longmemeval/run.ts` 13、`controller/run.ts` 3、`natural-maintenance/audit.ts` 3、`hierarchy-scale/run.ts` 2、`longmemeval/score.ts` 2、`omnimemeval/bridge.ts` 1——那是一个独立切片，而这个数字描述所记录检查点，不是在没有新范围检查时当前读者应预期的诊断
## 受控场景套件读数

这些是测试场景，不是独立自然用户任务或整个任务单元设计的产品验收。

- `node --experimental-strip-types --test --test-concurrency=4 tests/integration/ooo-ordinary-failure.test.ts tests/integration/ooo-managed-fence.test.ts tests/integration/ooo-read-paths-agree.test.ts tests/integration/ooo-round-query.test.ts tests/integration/ooo-task-tables.test.ts` -> 5, 3, 1, 2 and 4 pass, 0 fail, exit 0
