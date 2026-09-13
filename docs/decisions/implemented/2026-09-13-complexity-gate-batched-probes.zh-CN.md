# 复杂度门用两次 linter 运行测量一个 diff，并保留源码扩展名

[English](2026-09-13-complexity-gate-batched-probes.md)

**Status:** implemented  
**Approved:** explicit

## 问题

`complexity:gate` 为每个改动的代码文件启动**一个 ESLint 进程，而且每一边各一次**——工作树一次、同一文件在基线上再一次。进程启动约 0.8 秒，因此一个有 64 个改动代码文件的工作树在这个单项检查上花掉 **97 秒**。2026-09-13 实测：其余静态检查都在 0.9–7.0 秒之间（`lint` 4.2、`format:check` 3.6、`check` 7.0、`package:check` 5.9）。一次验证要跑几分钟，原因就在这里。

测量这个开销时又暴露出第二个、比时间更要紧的缺陷。[探针文件名当时由
`filePath.endsWith(".ts") ? ".ts" : ".js"` 推导](../../../tools/complexity-gate.ts)——而 `.mts` 并不以 `.ts` 结尾。于是一份 `.mts` 源码被写成 `.js` 探针，ESLint 按 JavaScript 解析，回答 `Parsing error: ',' expected.`，门就把该文件列入"无法测量"。`scripts/verify-docs.mts` 因此从未被检查过复杂度，两边都没有。

这份报告看起来并不像错：它正是这个门被重建后要学会打印的、诚实的"未能测量"提示。修好扩展名之后才看到它遮住了什么——同一个文件里的三处违规，其中两处是同一天才写的（`checkPostmortemRecord` 17、`checkPostmortems` 17，以及 `verifyDocumentation` 从 41 涨到 45）。一个看不见文档校验所在文件的检查，是盲区，而不是策略。

## 决策

在同一条测量路径上做两处改动，见
[`tools/complexity-gate.ts`](../../../tools/complexity-gate.ts)：

- **一次 linter 运行测量多个文件。** `complexitiesForMany` 先写出全部探针，再按累积路径长度分组（Windows 对参数长度有上限），用尽可能少的 ESLint 运行测完。ESLint 本来就按文件分别报告，因此逐文件的结论不变。`complexitiesFor(file, source)` 保留为单文件包装，供调用方与测试使用。
- **探针保留源码自身的扩展名**（`probeExtension`），使 linter 选择的解析器与模块类型始终与被测文件一致。
- **探针写在被 gitignore 的临时目录**（`.nmg/complexity-probes/`），并由入口点在收到 `SIGINT`/`SIGTERM` 时清掉本次写入的文件。

保持不变的部分：基线是哪个 revision、陈述基线的那句话、"未能测量"文件的点名方式，以及 diff 感知的判定。批量化没有搬动任何结论：它新增的每条失效路径——进程没产出任何东西、stdout 无法解析、ESLint 根本没有返回该文件的条目、一批中某个文件有致命解析错误——都归结为"未测量"（门会打印出来），而绝不会变成"已测量且干净"。

修复后的测量在 [`scripts/verify-docs.mts`](../../../scripts/verify-docs.mts) 里发现的三处违规在同一次变更中修好——事故复盘的头部扫描、编号、索引检查各自独立成函数，决策文件的计数器移出 `verifyDocumentation`——因此本次变更自己的门运行是干净的。

## 考虑过的替代方案

**保留每文件一个进程，改为并行。** 仍然是每文件一次进程启动；墙钟时间降到 N/核数，而门会与同一路由的其余检查抢 CPU。ESLint 本就按文件返回 JSON 报告，说明进程数不是值得优化的那个变量。

**按内容哈希缓存复杂度。** 会引入第二份"测过什么"的真相，以及"配置变了没有"这个失效判断——而门的诚实性一节正是为了排除这类东西。批量化之后也不再需要。

**当前侧直接 lint 磁盘上的真实文件，只对基线用探针。** 还能更快，也很诱人，因为基线在磁盘上没有文件。否决理由：两边会走不同的路径，两侧之间任何解析器差异都会表现为复杂度差异——正是这个门绝不能产出的假结论。

**把 `.mts` 视为范围之外，而不是修扩展名。** 那是把盲区变成一条有文档的豁免，而 `.mts` 正是文档校验器本身所在的扩展名。

**只修扩展名，保留每文件一个进程。** 正确，但 97 秒还在。两个缺陷同在一条测量路径上，而且暴露盲区的那个文件同时也展示了开销。

## 验证

- 同一个 64 文件工作树上，旧版与新版**逐行相同**，唯一差别是两行 `could not measure scripts/verify-docs.mts` 消失——该文件现在被测量了，并在上面的重构之后保持干净。
- 同一工作树上 `npm run complexity:gate`：97 秒 → 8–10 秒，剩余 13 处违规全部在别人开着的文件里。
- 三条回归测试，每条锁住一个此前毫无保护的性质：`a probe keeps the source extension, so a .mts file is measured`；`one unparseable file in a batch leaves the others' verdicts alone`；以及 `probes are written where git cannot see them`（同时断言临时目录位置与 `changedFiles` 不会返回探针）。都在 [`tests/tools/complexity-gate-base.test.ts`](../../../tests/tools/complexity-gate-base.test.ts)。
- 已有的四条诚实性测试仍通过：基线选择、陈述基线、超过上限的已测文件、linter 无法解析的文件。
- `npm run docs:check` 0 错误、0 警告；事故复盘层自身的复杂度也已回到上限之内。

## 后果

- 剩下的 8–10 秒由 66 次 `git show`（读取基线，3.6 秒）、两次 ESLint 运行和进程启动组成。代价现在大致随 diff 规模经由 `git show` 线性增长，而不再经由进程创建。
- 探针现在数量多且同时在盘，因此被中断的一轮会留下比过去更多的临时件：控制台中断由入口点的处理器清理，硬杀不会，两者都不假设。临时目录被 gitignore，所以残留物是惰性的——这一点是实测的：用旧写法中断一轮会在仓库根留下 42 个探针文件，每一个都对 `git status` 可见，下一轮就会把门自己的垃圾当成改动的代码文件。
- 扩展名保真是一次行为变化：改动的 `.mts`、`.mjs`、`.cts`、`.cjs`、`.jsx`、`.tsx` 文件从此会被测量，而过去可能被报成"无法测量"。新出现的违规是预期结果——本次变更自己就产生了三处，且都在前一天写的代码里。
- 当探针路径超过参数预算时，每 6 KB 路径多一次 linter 运行，这是有界的代价，而不是按文件计价。
- `.mts` 文件在这个门存在的全部时间里都未被测量，而此前那次清除假绿评审没有覆盖扩展名 fallback，因为探针名字读起来像是实现细节。新测试断言的正是扩展名，也就是 fallback 弄错的那个性质。

## 未完成项

用一次 `git cat-file --batch` 读取基线，替代每个文件一次 `git show`（可再省下 10 秒中的约 3 秒）；并把两侧合并进一次 ESLint 运行。
