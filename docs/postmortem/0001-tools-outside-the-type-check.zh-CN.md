# 0001 - 检查别人的工具，自己没被检查

[English](0001-tools-outside-the-type-check.md)

**Status:** open

## Executive summary

我两次把 mutant 锚点经 shell 文本路径写入 `tools/mutation-teeth.ts`，本意的 `\n` 变成字面换行，落在一个
TypeScript 字符串字面量里；工具于是以 `ERR_INVALID_TYPESCRIPT_SYNTAX` 死掉而不是运行——同一会话、同一机制、
两次。而 `tools/**` 根本不被类型检查：在一个 `tools/` 文件里放 `const x: number = "not a number";`，
`npm run check` 仍然 **exit 0**——因为 `tsconfig.json` 只逐名包含 `tools/` 的三个文件，ESLint 的配置也不覆盖该目录。
它掩盖的错误类别可以量：把 `tools/**/*.ts` 加入 include，出现 **2 个文件 3 个错误**。
结论：用白名单限定"被检查的文件"，就等于让每个新工具默认不被检查——而缺的正是这个检查。

## Summary

我在加 mutation tooth 时把锚点与替换写成 TS 字符串字面量。经 shell 或 Python 写文件会把本意的转义变成真换行；
这不是类型错误，而是模块的语法错误——所以文件在静态上就是坏的，只有 Node 加载它时才报错。两次的修复都是改用
按字面处理文本的编辑器重写。

系统性的那一半不是转义失误本身，而是仓库当时没有办法发现它。`tsconfig.json` 包含 `src/**`、
`.pi/extensions/**`、`claude-plugins/**` 以及 `tools/` 下**逐名列出**的三个文件
（`autodiff-benchmark.ts`、`repo-context.ts`、`agent-verify.ts`），不含 `tools/mutation-teeth.ts`；
ESLint 的 glob 也不覆盖该目录。于是一个其输出被其他评审当作证据的工具（"27/27 mutant 命中"）反而成了
本次变更里被检查得最少的代码。

## Impact

没有产出假证据：工具拒绝启动，所以它从未把没能运行的 mutant 记成"命中"，损坏期间也没有发布任何数字。
代价是两轮调试，花在一个类型检查本可立刻报出的失败上。

被掩盖的部分不同、也更大：任何未被检查的 `tools/` 脚本里的类型腐坏都是不可见的。在本记录量测的那棵树上
扩展 include，暴露出 `tools/fork-merge-demo.ts(89,39)`、`(90,39)`（`TS18046`，`json.left`/`json.right` 为
`unknown`）以及 `tools/complexity-gate.ts` 的一个 `TS2322`。这些错误是既有的、不是本次引入的，也正是该
guardrail 落地前必须先清掉的东西。

## Timeline

- B3b 加牙 `round-publication-opens-its-own-transaction`：锚点经 shell 路径写入，转义变成换行，
  `npm run mutation:teeth` 以 `ERR_INVALID_TYPESCRIPT_SYNTAX` 失败；用能保留 `\n` 的编辑器重写同一字面量修好。
- 单一边界那一刀，加牙 `a-method-opens-its-own-transaction`：同一写入路径在同一文件里产生同一缺陷，写入与修复都重演。
- 验证根因：在一个新的 `tools/` 文件里写 `const x: number = "not a number";`，`npm run check` —— **exit 0**。
- 量 guardrail 成本：复制 `tsconfig.json` 并加入 `tools/**/*.ts` —— **2 个文件 3 个错误**。

## Root cause

"被类型检查的文件"是一个白名单，于是新工具默认进入未被检查的集合，而且没有任何东西提示这件事。未被检查的
文件无法让检查失败；一个不被任何测试加载的文件里的语法错误根本不会被观测到——它由第一个运行它的人观测到，
且出现在一次输出看起来像进展的运行中途。任何不尊重 TypeScript 转义而写出源码的机械变换（shell heredoc、
Python 写字符串、`sed`）都会落进这个盲区。

所以"我会小心"不是解法：弄坏它的编辑与修好它的编辑，是同一批按键换了工具，而只有其中一个可被检查。

## Guardrails added

尚未。候选是 `tsconfig.json` 里的一行：

```json
"tools/**/*.ts"
```

前提是先清掉量到的 3 个错误。本记录没有落地它，是因为 CI 契约的拥有者正在同一工作树里改同样的文件，
从这里落地会让两处在飞中的变更重叠。在它落地之前，这个类别仍未被抓到，记录保持 `open`。

保留下来的实例级习惯更窄，但值得写明：mutant 锚点只用保留 `\n` 的编辑器写，绝不经 shell 字符串生成。

## Lessons

- 被检查文件的白名单是对既有文件的承诺，对下一个文件什么也没说。宁可让 glob 覆盖整个目录，把例外写明确。
- "这只是个工具"是错误的方向。一个工具的输出被引用来当证据越多，它就越需要和被它评判的代码同等的检查——
  mutation 工具是极端情形，因为它的输出是一个没人会手工复算的计数。
- 在工具启动**之前**就失败，是幸运的失败。同一个盲区同样可以掩盖一个错误的结果。
