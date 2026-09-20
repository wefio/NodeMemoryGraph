# 测试不需要文件系统

[English](2026-09-20-tests-need-no-filesystem.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [派发循环是共享的](2026-09-19-dispatch-loop-is-shared.zh-CN.md)、[变异扫描与证据规则](2026-09-19-sweep-and-evidence-rules.zh-CN.md)

## 问题

单元产出的每个候选，都在一个一次性工作区里被验证：`verifyCandidate` 先建临时目录，再
`git worktree add --detach`，用 junction 把 `node_modules` 链进去，写候选文件，在那儿跑检查，最后删树。
本机实测：`worktree add` 冷 580 ms、热 79 ms，`git worktree remove` 254 ms，`reset --hard` 140 ms，
`clean -fdx` 88 ms。一个单元约 0.94 s，大头是 git；一个真派发的用例约 5.0 s；臂的驱动 suite 17 个用例
82.5 s——而不做派发的用例只要 0.2 s，建黑板存储只要 22 ms。花掉的是文件系统与 git 进程，不是被测的
性质：臂的单元检查是 `node --experimental-strip-types --test <fixture>.test.ts`，而它跑的 fixture 是
几个很小的纯模块——为了给一个测试文件三个可 import 的文件，每个单元建了一棵树。

这些工作区也是被中止的运行留下的东西。有一轮查出 7 个仍然注册在 git 里的候选工作树（有的 `locked`、
有的 `prunable`）和 10 个临时目录：它们拖慢之后每一次 git 调用，而"树里带着别人留下的状态"正是让测量
在看起来正常的同时失真的那类错误（0003 同类，往外一层）。

## 决策

**检查读数据、给判定，宿主什么都不准备。**

- **数据检查**是 `{files, frozen}` 上的一个函数，返回判定（`src/integration/ooo-candidate.ts` 的
  `DataCheck`），`verifyDataChecks` 在进程内跑它。什么都不创建，于是没有要准备的东西、没有要清理的
  东西、被中断的运行也没有可泄漏的东西。判定规则与命令检查共用同一份，两者不可能意外地给出不同答案。
- **命令检查**在**调用方准备好的工作区**里跑，`verifyCandidate` 接收它（`{workspace, files, checks}`）：
  把候选文件写进去、跑检查、报回结果。它不再接收 repository 与 revision，因为它不再创建任何东西。检查在
  哪棵树里跑、那棵树干不干净，是调用方的事——发现环境不对的检查报 `undecidable` 而不是猜，收拾环境不是
  宿主的事。
- **臂的检查就是它们的 fixture 测试文件**，在内存里对着候选文件跑（`evals/ooo-execution/data-check-runner.ts`）：
  测试文件与它 import 的模块都从候选的文件集里取，在进程内转译，再用一个会解析 fixture 自身相对 import 的
  模块系统求值。于是 spec 的检查声明是 `{label, test}`——单元必须通过的那件事的可序列化描述——而不再是
  命令加参数。
- `evals/ooo-execution/candidate.test.ts` 随它测试的机械一起退役。`verifyCandidate` 留下了一个调用方
  `evals/ooo-execution/mutation-probe.ts`，它需要在真树里跑真检查：这个工具现在自己准备一棵工作树、在每个
  变异之间 reset、最后删掉——需要工作区的调用方自己拥有它。

## 考虑过的替代方案

- **每个并发槽池化一个工作树，候选之间 reset 复用。** 每候选更便宜（`reset --hard` 140 ms 加受控
  `clean` 88 ms，对照 add 加 remove 的 350–830 ms），但仍然要建目录、仍然要清理，而且把候选之间的共享
  状态放到了验证所依赖的隔离之上。测试路径上否决；调用方自己决定要工作区时它仍可用——`mutation-probe.ts`
  现在就是为自己这么做。
- **给每个候选一个装冻结文件的临时目录，不碰 git。** 那仍然是宿主替测试建目录，而且需要整个仓库的检查
  会静默地看到太少，而不是报错。
- **保持现状。** 每用例 5.0 s，且每次被中止的运行都会在 git 里留下注册的工作树。否决。
- **手动准备一次环境，复用。** 部分采纳，它就是本决策的另一半：谁需要工作区谁自己准备。对测试来说答案
  是根本不需要，而不是准备得更好。

## 后果

- **前后都量过。** `evals/ooo-execution/plan-driver.test.ts`：17 个用例，82.5 s → 4.7 s。
  `evals/ooo-execution/families.test.ts`：8 个用例，1.3 s（真 fixture 检查，在内存里）。
  `tests/integration/ooo-dispatch.test.ts`：8 个用例，0.6 s，不变——它从来没用过文件系统。一个真派发的
  用例从约 5.0 s 降到 0.17 s；交错那个用例花的是它自己声明的 1.5 s。驱动的变异车道：clean 106.9 s →
  5.5 s，5 个变异全部由各自点名的用例抓住，每个 0.8–1.2 s。
- **牙齿仍然在。** 两个目标合计 13 个变异全部由各自点名的用例抓住，两棵树都按字节还原：`src/integration/ooo-dispatch.ts`
  8/8，`evals/ooo-execution/plan-driver.ts` 5/5。父检查组合那个变异正是依赖候选隔离的那条，抓住它的家族
  用例仍然抓得住。
- **仪器变了，读数不能混。** 臂各格的 host 时间与 wall 时间都记录自己跑自哪个 commit；本决策之前的格为
  每个单元付了一棵工作树，之后的格没有。归档读数按其自身仪器成立，不能当作"差别就是计划"来比较。
- **数据检查没有进程边界。** 它不能被超时杀掉，也不能以进程方式执行候选代码。这是这里付出的代价，也正是
  规则只覆盖"输入是数据"的检查的原因：必须在超时下执行候选代码的检查仍然是命令检查。
- **spec 声明的是一份测试，不是一条命令。** 本决策之前写下的 spec 声明命令与参数，会被 `checkList` 的
  类型**指名拒绝**而不是静默跳过；`evals/ooo-execution/fixtures/` 里的 fixture spec 已在同一次改动里转换。
- **臂的驱动验证任何东西都不再需要仓库。** 它仍然从工作树读基线、仍然对着它跑实时 worker；验收这条路径
  两者都不需要。

## 未完成项

- **产品那条 live 路径仍然声明命令检查。** 扩展把它自己的检查交给 box，那些检查在哪跑由那条路径决定。
  给那条路径一个声明的、调用方准备好的工作区——以及一份共享宿主能重建的可序列化检查描述——属于声明对齐
  那项工作，不属于本决策。
