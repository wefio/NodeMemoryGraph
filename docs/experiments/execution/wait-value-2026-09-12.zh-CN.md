# 等待实际值多少（受限 OoO）

[English](wait-value-2026-09-12.md) | [简体中文](wait-value-2026-09-12.zh-CN.md) · [术语](wait-value-2026-09-12.terms.yaml)

**相关：**[设计](../../design/ooo-execution-bootstrap.zh-CN.md) · [admission run](../ooo-admission-2026-09-08.zh-CN.md) · [speculation 决策](../../decisions/implemented/2026-09-11-ooo-speculation.zh-CN.md)

测量日期：2026-09-12。没有模型 token：以下数字均未调用 provider。

## 问题

设计前提是：out-of-order execution 通过让本来就要做的工作覆盖外部等待来节省墙钟时间。它也规定了该主张的证据：“后台操作与 B 的时间重叠才是等待被利用的证据。”本次同时询问：随着 check 变长，这个前提是否成立；round 报告的数值是否测量了设计所定义的量？

## 方法

`evals/ooo-execution/probe-check-duration.ts` 通过 `compareModes` 驱动真实 `runCycle`，因此使用生产版 orchestrator、board、candidate worktrees、check processes 和 acceptance rules。两个维度是人为选择而非观察所得：

- round check 在真实子进程中执行指定时长 τ 的 CPU 工作；
- task B 在返回 accepted answer 前额外执行指定时长 β 的 CPU 工作。

探针已提交至 `evals/ooo-execution/probe-check-duration.ts`，通过 `--check-ms`／`--worker-ms` 扫描，并写出表格与 JSON 记录，因此可复跑网格。将其移入仓库后发现它已失效：对 `round-log.ts` 的导入仍指向 OoO storage 搬迁前的 evals 目录，无法启动。它验证的指标改动位于 `cycle.ts` 并有测试。Replay 会立即返回，因此 offline arm 完全无法与等待重叠。CPU 密集 worker 是真实情形的**下界**：两个 CPU 活动会争用核心，而模型调用主要等待网络。答案沿用 comparison test，且每个网格点都检查质量一致（全网格 verdict 相同）。

下表中的 “harness hidden” 是 round 报告的 `measurements.hiddenWaitMs`；“task-covered” 是从 round log 独立计算的同一重叠量。

## 观察结果

修正后的定义（task 自身 claim-to-return 窗口 ∩ check 窗口）：

| check τ | worker β | OoO wall | sequential wall | OoO − seq | harness hidden | task-covered |
|---:|---:|---:|---:|---:|---:|---:|
| 0s | 0s | 3.19 s | 3.96 s | −0.77 s | **0 ms** | 0 ms |
| 0s | 2s | 5.08 s | 5.98 s | −0.90 s | 838 ms | 2.06 s |
| 0s | 8s | 11.07 s | 11.80 s | −0.73 s | 835 ms | 8.06 s |
| 2s | 2s | 12.98 s | 15.61 s | −2.63 s | 2 059 ms | 2.06 s |
| 2s | 8s | 18.98 s | 21.57 s | −2.59 s | 2 715 ms | 8.05 s |
| 8s | 2s | 36.95 s | 45.48 s | −8.53 s | 2 049 ms | 2.05 s |
| 8s | 8s | 42.82 s | 51.54 s | −8.73 s | 8 050 ms | 8.05 s |
| 40s | 2s | 165.04 s | 205.71 s | −40.67 s | 2 053 ms | 2.05 s |
| 40s | 8s | 171.12 s | 212.11 s | −40.99 s | 8 050 ms | 8.05 s |

作为对照，旧定义下同一网格的早期 run 在 `(0s, 0s)` 报告 713 ms，在 `(40s, 2s)` 报告 40 647 ms。

九个点的 soundness 检查均通过：A 的 artifact 时间戳严格晚于 check terminal event，因此节省没有破坏顺序规则。

## 数值说明

1. **任务覆盖的等待为 `min(τ, β)`。**无论 check 如何变化，它都不超过任务自身工作量，因此“等待越长，隐藏越多”的解释被否定。占 round 的比例在 check 与独立任务时长接近时最高（8 s / 8 s ⇒ control wall 的 15.6%），两侧都会下降。
2. **墙钟节省是另一种量。**当 τ ≫ β 时，round 几乎快了整个 τ（−205.7 s 中节省 −40.7 s），而任务自身工作只覆盖其中 2.05 s。查看 round log 可知原因：check 与 **host 对 B 的 verification** 重叠（mutation matrix 和 candidate check，其窗口各自包含一个 τ 长度的 run）。这是真实重叠，是设计允许的 A 类 host-side overlap，也缩短了 round；但这是 host 工作与 host check 重叠，不是独立任务工作覆盖外部等待。按设计的证据规则，只有后者算等待利用。
3. **观察到的上界形状为 `1/k`。**Round 大约串行花费 `k·τ` 做 verification pass（此处 `k=4`：round check 加每个 task 一个 candidate check）。任务覆盖等待最多一个 τ，因此它占 round 的比例最多约为 `1/k` ≈ 25%。操作点 τ=1.9 s、β=54.8 s（round 7：134.9 s）落在 1.4–3%，与设计早先记录的 1.6 s 一致。

## 报告指标自身的缺陷

`hiddenWaitMs` 原来按 task 的 **claim-to-submission** 窗口计算，而 submission 在 host 验证 candidate 之后才发生。由于 verification 窗口长于 check，即使 task 自己只工作了很短时间，该指标也几乎把整个 check 报成 hidden。`(0s, 0s)` 是证明：什么都没有可覆盖，却报告了 713 ms 的“hidden wait”。现改为 claim-to-return 窗口（`src/integration/ooo-cycle.ts`），并在 `cycle.test.ts` 中加了两个回归测试：没有独立工作时报告必须为零（`(0s, 0s)` 为 0 ms）；区分性 case（1.5 s check、0.2 s task）报告 2 053 ms，旧定义会报告 1 539 ms——回退指标会使测试失败。其他地方引用的历史数字（round 的 40.6%、hidden 54.8 s）仍沿用旧语义，应理解为“与 task attempt 窗口重叠的 check 窗口”，而不是任务工作覆盖的等待。探针里的独立列在修复前也犯了同一错误，所以两列从 `(2s, 2s)` 起才一致。

## 未测量

- 本扫描没有运行模型：β 是真实 CPU 工作，因此对网络等待的模型时间只是下界近似。
- 每个网格点只有一次重复，没有分布或 held-out workload。
- Check 是受控 CPU load，不是真实 integration check；真实 round check 约 1.9 s，操作点数值使用此值。
