# 设计的第一个切片：共享的纯数据编译器与有限的离线模型

[English](task-semantics-slice1-2026-09-13.md) | [简体中文](task-semantics-slice1-2026-09-13.zh-CN.md) · [术语](task-semantics-slice1-2026-09-13.terms.yaml)

**Related:** [任务单元语义设计](../../design/task-unit-semantics.md) ·
[决策记录](../../decisions/implemented/2026-09-13-task-unit-semantics.md) ·
[OoO 自举设计](../../design/ooo-execution-bootstrap.md) ·
[等待的价值](wait-value-2026-09-12.md)

2026-09-13 测量。零模型 token：下文任何数字都没有为此联系过 provider，且两个新模块不导入 store、不导入数据库、不导入网络。

## 问题

本文记录首个研究编译器／模型检查点，不是所有当前调用者或产品 `taskRun` 状态。
行数、测试与 mutation 结果均为历史；本轮未执行它们或复现命令。
[后续用例报告](task-semantics-design-cases-2026-09-13.zh-CN.md)记录后来的 input-closure
检查与明确未建模范围。

设计的第一个切片被规定为**共享的纯数据编译器加上一个有限的离线执行模型**：无模型调用、无 board 表变更、无新 store。其中有两条主张无需这些即可检查，因此本次 run 检查它们，而不是重述它们：

1. 编译现有契约是否会产生一个**带位置地拒绝不支持映射**的视图，而不是静默丢弃它们？
2. **一个验收谓词**能否同时服务状态查询与依赖释放，且建立在它之上的模型能否展示融合的代价，而不是断言该代价？

## 构建了什么

| 文件                                             | 行数 | 角色                                                                                                                                                                                     |
| ------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integration/task-semantics.ts`              | 552   | 编译器：从 `ProbePlan` + `PatchTaskSpec` + cycle 的 `Requirement` 派生 `TaskUnit[]`；它自身不冻结任何东西（仍由 `preparePatchWork` 冻结）；持有唯一的 `isAccepted` 谓词 |
| `src/integration/task-semantics-model.ts`        | 179   | 模型：在 ≤4 个单元上枚举 `ordered`／`out-of-order`／`fused` 的合法结算顺序，并计数等待、回滚、重试                                                    |
| `tests/integration/task-semantics.test.ts`       | 322   | 12 个用例                                                                                                                                                                                     |
| `tests/integration/task-semantics-model.test.ts` | 132   | 7 个用例                                                                                                                                                                                      |

首切片检查点尚无运行时路径调用这两个模块。设计的迁移顺序把编译器与模型放在最前、把 runner 放在最后；这就是那第一步，且它被有意做成惰性的。

## 证据

| 检查           | 命令                                                                                                   | 结果                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 类型           | `npm run check`                                                                                        | 0 errors                                                                |
| 复杂度         | `npm run complexity:gate`                                                                              | `4 changed code file(s) … 0 method(s) above 15`                         |
| lint／format   | `npx eslint src/integration/task-semantics*.ts`, `npm run format:check`                                | clean                                                                   |
| 编译器套件     | `node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics.test.ts` | 12 pass, 0 fail                                                         |
| 模型套件       | `… tests/integration/task-semantics-model.test.ts`                                                     | 7 pass, 0 fail                                                          |
| mutation teeth | `npm run mutation:teeth`（历史标签；原称“当时是本地脚本”，见下文）                                              | 8/8 mutants caught **by name**; both files restored byte-identically |

teeth 检查现在位于仓库的 `tools/mutation-teeth.ts`（`npm run mutation:teeth`），这是后来的仓库入口。原记录还称落地时使用本地脚本，但此处没有准确历史调用／顺序；保留 mutant／预期用例名字，不证明相同 register 或在当前 checkout 复现 8/8。它报告在它所运行的那份 checkout 中哪些 mutant 适用，因此代码位于另一分支的 target 会被报告为不适用，而不是计入已抓到。

teeth 检查报告三种结局而不是一种：干净运行必须通过、每个 mutant 必须在预期测试名下使套件失败、被改动的文件必须逐字节原样返回。anchor 缺失的 mutant 会被报告为未认领（unclaimed），而不是已抓到。

## 原测试输入下的 budget mutant

第一个 `budget` mutant——删除 `spec.budget` 内拒绝未知键的那个循环——**未被抓到**，且在 mutation 存在的情况下套件仍以 0 退出。原因不是断言太弱：`maxBytes` 与 `maxOutputTokens` 是顶层 spec 字段，因此它们被相邻的 `SPEC_FIELDS` 检查拒绝，内层循环从未被到达。旧选定输入在到达被改循环前已失败，因此未区分该 mutant；这是测试输入未区分，不是程序对所有输入语义等价，后续用例展示了可观察差别。

新增了两个用例（`budget.bytesPerFile`、`limits.deadlineMs`，以及一个高于 `MAX_PATCH_BUDGET` 的 `perFile`），此后同一 mutant 被抓到。这条通用教训被记录，因为它可推广：**一个不使任何东西失败的 mutant 不总是缺失断言；做这件事的可能是相邻检查**，点名预期失败的测试有助定位实际检查的规则，但不单独证明完整覆盖或等价。

## 模型展示了什么（两个单元，`D` 依赖 `P`）

这是在 `P → D` 计划上、结局预定义的 `compareModes` 报告计数。`waits` 是模型事件
数量，不是耗时；区间来自合法结算顺序，不是统计置信区间或独立运行。`fused` 是此模型
标签，不证明真实模型会话复用：

| 结局                       | 模式         | orders | waits | rollbacks |
| -------------------------- | ------------ | ------ | ----- | --------- |
| `P` accepted, `D` accepted | ordered      | 1      | 1..1  | 0..0      |
|                            | out-of-order | 1      | 1..1  | 0..0      |
|                            | fused        | 2      | 0..1  | 0..0      |
| `P` rejected, `D` accepted | ordered      | 1      | 1..1  | 0..0      |
|                            | out-of-order | 1      | 1..1  | 0..0      |
|                            | fused        | 2      | 0..1  | 0..1      |

在 `P` 结算之前就启动 `D` 的那个融合计划记录 `waits: 0, rollbacks: 1, retries: 1`，且在 `P` 被拒绝时什么也不验收；而选择等待的计划记录 `waits: 1, rollbacks: 0`。因此融合买来顺序自由，并以回滚为代价——模型陈述这一权衡，而不是假定它是免费的。另请注意，两张表中 fused 模式的_下限_都是零回滚：融合仍然可以选择等待，这就是为什么该比较被报告为一个区间，而不是单一最佳情形。

## 这没有建立什么

- 不建模模型调用、不建模墙钟、不建模真实验证、不建模外部等待（记录中的 `UNMODELLED_BY_MODEL` 点名墙钟、真实验证与外部等待缺口）；枚举上限是四个单元。
- 首切片检查点点名的两个缺陷**未由该切片修复**：`src/integration/ooo-board.ts` 中的 `accepted()` 拼接 board 裁决，而依赖释放读取 `artifact !== null`；`ooo_probe_tasks` 混入了不可变输入、候选字节与可派生状态。编译器编码了能修复第一个缺陷的单一谓词；把该研究轮次切换到它上面是后续工作，不是本轮对当前状态的审计结论。
- 编译器拒绝冻结文件之外的读或写路径、越界预算、未知 requirement 类型、cycle，以及没有 verifier 的 spec。它尚未拒绝_数据_依赖缺失的 refinement，因为设计没有父义务映射可供对照——此处的 refinement 检查接受一个由宿主声明的拆分。用例报告中具体的 `input-closure` 修复不替代对更广的父义务映射的证明。

## 复现

所保留命令面向历史实现分支，不是任意当前工作树，本轮未执行。获授权运行前须读当前
操作 owner；保留代码块不保证相同计数或源码布局。

```bash
cd <worktree on this branch>
npm run prompts:generate          # generated prompts are not tracked
npm run check && npm run complexity:gate && npm run format:check
node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics-model.test.ts
npm run mutation:teeth   # every mutant from slices 1-3, checked by name
```
