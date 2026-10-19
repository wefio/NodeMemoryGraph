# Fusion 质量现场试验，2026-09-19

[English](README.md) · [术语](README.terms.yaml)

**范围：**每个 arm 在一个 fixture、一个 model 上各进行一次 live board run。这是有限的研究对比，不是通用质量、成本或产品接入结果。

两个 arm、一个真实 model、每个 arm 一次 board run。问题是：在边界继续使用同一个 session 是否能改善质量或成本？两组只差一个 declaration，因此其他差异都不能作为该对比的一部分。

## 运行内容

在 `fixtures/pipeline/fine.spec.json` 上执行 `plan-driver.ts run --slots 1 --live`。该 fixture 有四个 unit（`normalize`、`scale`、`total`、`summarize`），每个 unit 修改一个文件并由自己的 test 检查；组合 pipeline 是固定的 parent acceptance。Provider 为 `deepseek`，model 为 `deepseek-v4-flash`，两组使用默认声明上限。

| Arm | Spec | 与另一组的差异 | Sessions |
| --- | --- | --- | --- |
| control | `control.spec.json` | 无（fixture 原样） | 四个，每个一个 unit |
| fusion | `fusion.spec.json` | `fusion: { unitsPerSession: 2 }` | 两个，每个两个 units（`fusion6.json`） |

`evals/ooo-execution/make-fusion-trial-specs.mjs` 从离线 fixture 生成两份 spec；若 fixture 已声明 fusion、provider 或 model 需要猜测，或两份 spec 除 arm id 与 fusion declaration 外还有其他差异，脚本都会拒绝。

两份保存的 spec 文件是本试验实际使用的输入，并保留了当日的 check declaration（`{label, command, args}`）。Arm driver 现在将 check 声明为运行的 fixture test 文件（`{label, test}`），并按类型拒绝旧格式。因此重新运行此计划时，必须用当前 fixture 通过 `evals/ooo-execution/make-fusion-trial-specs.mjs` 重新生成两份 spec（见[决策](../../../decisions/implemented/2026-09-20-tests-need-no-filesystem.zh-CN.md)）。

## 结果

两组都接受了全部四个 unit 与组合 parent；没有 unit 被拒绝。一次对比无法比较质量。下表记录 wall time 和 token/cache 数量，不是 provider 货币成本。

| 项目 | Control | Fusion | Fusion / control |
| --- | --- | --- | --- |
| 已接受 units | 4 / 4 | 4 / 4 | - |
| Parent verdict | accept | accept | - |
| `tokens` | 30 000 | 34 601 | **1.15x** |
| `cacheRead` | 17 408 | 24 064 | **1.38x** |
| `cacheWrite` | 0 | 0 | - |
| `wallMs` | 24 849 | 16 054 | **0.65x** |
| `hostMs` | 5 145 | 4 089 | 0.79x |
| `hostChecks` | 4 | 4 | - |
| `sessions` | 4 个新 session | 2 个 fused session | - |
| 每 unit tokens | 7 524 / 7 339 / 7 246 / 7 891 | 7 873 / 9 635 / 7 601 / 9 492 | 1.05x / 1.31x / 1.05x / 1.20x |

因此，在这个 fixture、这个 model、每组一次重复的条件下：fusion 没有节省 tokens，反而多用了 15%；四个 unit 的 token 差值全为正。Wall clock 少了 35%。每个 fused session 的第二个 unit token 增幅更大，而不是降低；在这次对比中，warm context 更长而非更便宜。该对比不能建立 continued session 的普遍成本结论。

## 这次 arm 的测量成本，以及发现的两个缺陷

Fused arm 首次运行没有产生任何测量：它在第一个 unit 上失败，执行到声明的 3 turns 之外，在第 4 turn 中止。只有修复 instrument 后，失败信息才变得可读——错误行现在会打印 turns 与上限、reads 与上限、unit 调用过的工具，以及 envelope 最近一次拒绝的原因。按顺序看：

1. `stopReason=error, turns=4/3, reads=1/2`——发生中止，但看不到原因。
2. `calls=read_snapshot,run_check,submit_artifact, artifact=no artifact`——模型将一个 turn 花在 `run_check` 上；该工具只对 session 中其他 unit 开放，而当前 unit 没有 check。
3. `last refusal: a patch carries files only; it cannot also carry a conclusion`——提交同时携带两种回答通道，因此被拒。该规则属于 envelope，schema 无法表达。单次尝试会收到包含结论分支的 literal union，因此很少猜错；fused session 在创建时就固定 surface，只能把该 union 放宽为 string，所以这两项规则仅对该路径移入 prompt。

现在 `patchSessionInput` 会在 `looseConclusion` 开启时携带它们；严格路径与此前逐字节一致（由 `tests/integration/ooo-session-chain-contract.test.ts` 断言），因此上面的 control arm 仍描述了产生该结果的代码。

## 本文不说明什么

每个 arm 只有一次重复，无法计算 spread，所以上述比例都没有得到确立。D arm 在另一种双单元 plan 上每个 arm 运行了三次；其每次运行 token spread 为 17.6k–26.3k，大于本对比显示的 15% 差异，因此这里只能报告方向。`control.json`、`fusion5.json`（诊断运行）与 `fusion6.json`（测量运行）是原始结果；将 `--runs` 设为大于 1 才能得到速率等级。本文无法区分 warm context 成本与在同一 surface 下运行两个 units 的成本；fixture 中的 unit 足够小，session 启动成本仍可能占主导。
