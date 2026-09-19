# 0003 - 我读到的检查，读的是 mutant

[English](0003-checks-read-a-live-mutant.md)

**Status:** resolved

## Executive summary

在一条 detach 的 `mutation:teeth` 正在把 mutant 留在树里时，我跑了 `npm run lint` 与
`npm run complexity:gate`。它们报出的失败描述的是 **mutant**，不是我的代码：`no-constant-binary-expression`
正好落在被替换成 `if (false && …)` 的那一行，一个未使用变量告警就是父检查那个 mutant，两个复杂度数字
是照着被改写的源码量出来的。我之所以察觉，只因为那行 lint 认出是我自己刚写的 mutant。风险其实早已写下
——"mutant 在跑时不要编辑、不要 `git add` 它的目标文件"——但那是一条关于**写**的规则。检查只是**读**，
所以规则没有触发，而 harness 也没有在树里留下任何检查能看见的痕迹。

## Summary

本次改动为 `src/integration/ooo-execution.ts` 增加融合合法性、为 `evals/ooo-execution/cost-model.ts` 增加记账模式、为 `evals/ooo-execution/plan-driver.ts` 增加会话策略，
并在 `tools/mutation-teeth.ts` 登记新的具名 mutant。mutation 扫描属于三条昂贵车道之一，因此被 detach 启动；当我在前台
跑那些廉价 gate 时，它仍在运行。

`mutation:teeth` 的工作方式是把一个具名的错误版本替换进目标文件、跑本应抓住它的套件、再把文件按字节还原。
在替换与还原之间，**磁盘上的目标文件就是 mutant**。它的两个已登记 mutant 会把 `if (false && <条件>)` 替换进
`sharedSessionLegal`，而 lint 输出正是把该结构在 `:225` 报为常量真值错误；第三个 mutant 替换父检查的
裁决，这解释了为什么会冒出一个在我版本里其实被使用的变量的告警。复杂度 gate 报出 `sharedSessionLegal` 18、`runOneUnit` 17——
这两个数字是按当时磁盘上的任意文本量出来的，与我要问的问题并不是同一个。

在安静的树上重测，真实数字是 18 与 16，二者确实需要仓库规则所要求的辅助函数抽取。这种“接近”正是该失败
类别危险而非仅仅恼人的原因：同一个机制既能造出假失败，也能造出假**通过**，而在 mutant 窗口里读到的一条
绿灯，是关于一棵从未存在过的树的证据。

同一个失败类别随后**第二次**逃脱，方向相反——这正是让一次烦扰变成事故记录的原因。那条被 detach 的扫描是以
无法在父 shell 退出后存活的方式启动的，于是在运行途中被杀，把它的 mutant 留在了 `evals/ooo-execution/plan-driver.ts`：
bound 检查被替换成了 `if (false) return undefined;`。没有任何东西说明这一点——被杀掉的 harness 不写总结，当时也不移除锁。下一条扫描把这个文件继承为**基线**，
它自己的 clean run 失败（`clean run failed, the harness proves nothing`——工具说得对，是我不对），并且有一个 mutant 完全无法定位，因为它要的锚点已被遗留的 mutant 替换。

## Impact

产品行为零影响，也没有发布任何验证结论：污染读数在被采信之前就被识别，两个 gate 都在安静的树上重跑
（lint 0 error，复杂度 `ok`，20 个超阈值方法与基线相同）。代价是时间与风险——我把 lint 输出当成真实失败，
开始为满足 mutant 的复杂度数字构思重构，只因为那个被 lint 指出的结构与我几秒前写的 mutant 恰好同名，
才没有变成一次改动。如果 mutant 没那么好认，同样的读数会作为"关于我这次改动的事实"进入本次记录。

它**不可能**影响提交：扫描运行期间没有暂存任何东西，而扫描在每个目标之间会把文件按字节还原
（本次会话的运行分别报 `17 of 17` 与 `1 of 1` 还原）。

第二次逃脱的代价更大：两个具名 mutant 是在一棵**已经持有 mutant** 的树上运行的，它们的结论描述了一个从未存在过的
基线，另有一个 mutant 完全无法定位。代价付了两次——一次是误读的检查，一次是那个没人改过的文件上失败的测试。

## Timeline

- 融合合法性 / 成本模型 / 驱动策略三处改动写完，具名 mutant 已登记。
- detach 启动 `npm run mutation:teeth --targets evals/ooo-execution/plan-driver.ts`，前台空闲。
- 前台跑 `npm run lint`——此时扫描已把 mutant 替换进 `plan-driver.ts`，报 2 error + 1 warning。
- 同一窗口内跑 `npm run complexity:gate`，报两个函数超阈值。
- 细看 lint 行（`if (false && …)`）认出是自己写的 mutant：读数污染，该窗口内所有测量作废。
- 扫描结束：`10 of 11`，一个 mutant 锚点失配、一个套件无法区分。
- 树安静后：删掉冗余检查与其 mutant、抽取辅助函数，lint 与复杂度重跑通过。

## Root cause

两条机制，第二条正是第一条反复出现的原因。

第一，一次 mutation 扫描是**对树的写窗口**，而每个检查都是同一棵树的**读者**。仓库的规则只写了写的一侧
——"扫描在改写文件时不要编辑、不要暂存"——那恰是扫描进程自己能控制的一侧。读者无法分辨 mutant 与改动，
而"报错了别的文本"的检查看起来和"报对了"的检查一模一样。

第二，"有一个 mutant 活着"这件事**只存在于 harness 进程内**：树里没有锁、没有标记、没有任何检查能读的
文件。于是规则只能靠会话记忆跨过一整个被拆解的长任务来携带——而在一个"多车道并行"本身就是重点的任务里，
依赖记住的规则，注定会被丢掉。

第三，也是这个类别能逃脱两次的原因：一个**被杀掉**的 harness 会把树留在它进程当时的状态，而那个状态是
"mutant 已替换"。本该抓住它的规则是存在的——对死掉的运行先 `git diff` 它的目标——但那只是文档里的一步，
写给读者的记忆，而且落在读者**最不可能谨慎**的时刻：因为被杀掉的运行看起来什么都没发生。

## Guardrails added

机制现在写在树里，检查也读它：

- `tools/mutation-teeth.ts` 在 mutant 存活期间写 `.temp/mutation-lock.json`（记录目标文件），在还原、拒绝
  与退出时清除；若已存在另一条扫描的锁则拒绝启动——同一 worktree 里两条扫描是同一个风险换了读者。
- `tools/mutation-lock.ts` 是这把锁的唯一归属：树的写者与读者共用一个文件、一个含义，而不是每个工具各自
  发明信号。
  所有者**已死**的锁不再被当作无害而忽略：它被报成 `a previous sweep died holding <target>`，点名目标、点名 `git diff`，
  并且新的扫描**拒绝启动**而不是静默接手——正是这里被跳过的那一步。
- [`tools/agent-verify.ts`](../../tools/agent-verify.ts) 在锁存在时**拒绝验证**，并点名扫描正在持有的文件，
  让本该汇总本次工作的那条车道无法汇总一个 mutant。
- [`tools/repo-context.ts`](../../tools/repo-context.ts)（`npm run agent:context`）在 Reconciliation 段打印
  活锁——因为那是会话最先跑的指令。
- [`skills/repo-development/SKILL.md`](../../skills/repo-development/SKILL.md) 在 mutation 车道旁写下扩宽后的
  规则：扫描运行时，树对检查是**不可读**的，不止是不可写。
- `tests/tools/agent-verify.test.ts` 新增用例：锁存在时拒绝必须触发（去掉锁后必须重新通过）。

- `tests/tools/mutation-lock.test.ts` 钉住一把锁的三种读法：活着的所有者是正在运行的扫描，死掉的所有者是陈旧的，
  而**陈旧的锁会按名字拒绝新的扫描**。

## Lessons

- 改写共享资源的进程，必须能在它死掉之后**被检查而恢复**。"它死了就去看那个文件"直觉对、机制错：检查应当就是
  那把锁，而锁属于树——下一个进程不必记住任何事情就能找到它。
- 一次验证是三元组——结果、命令、**对象**——而"对象"包含"树是静止的"。0002 是同一条教训换了机制：那里的
  对象是工作树而不是提交；这里是替换到一半的树而不是源码。
- 污染读数里**危险的是假通过**，不是假失败。假失败会被调查，假通过会被记录。
- 关于某条车道的规则必须点名所有接触该资源的角色。"X 运行时不要写"和"X 运行时不要读"是两条规则，
  而后者有更多破坏方式。
- 如果事实只存在于某个进程的记忆里，规则就不能建立在它之上。锁文件不是官僚程序，它是"规则"与"指望"的区别。
