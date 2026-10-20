# 历史 S3/S4 轮次工具与评估

[English](historical-round-tooling.md) · [术语](historical-round-tooling.terms.yaml)

**权威归属：**[受限 OoO 的自举开发](../ooo-execution-bootstrap.zh-CN.md)。

历史实现记录；不表示当前已接入产品运行时。

## S3：可用入口（历史记录，2026-09-12 完成）

`round-spec.ts` 描述一轮：基线、检查、两个任务的指令/可编辑/可见集、用例、声明故障、准入结论、前提、预算与限额、worker 类型。`round-runner.ts` 将 spec 冻结成轮次，并把运行目录做成持久面；`round-cli.ts` 提供 `submit`、`status`、`cancel`。

重复一轮不需要修改研究脚本：运行同一 spec 并记录日志，再将 `worker` 指向这份日志重放。`cancel` 写入轮次自己的 store；运行中的轮次轮询它、自我取消，并杀掉在途检查进程树。另一个进程从同一运行目录读取 `status`。

2026-09-12 的边界更新将协调器、轮次编排、host 验证与轮次记录放在 `src/integration/ooo-{board,cycle,candidate,mutation,verifier,round-log}.ts`；`evals/ooo-execution/` 保留研究启动器（`live-*`、`round-{spec,runner,cli,compare}`）与测试。它**没有接入产品运行时**：既未连接 `src/cli`，也不默认接管 sessions。

Pi 增加了薄层 `ooo_round` 工具，像其他 NMG 工具一样默认注册。成本按调用区分：`live` 会花 tokens；默认 replay 使用已记录的答案，不花模型调用成本。`submit` 分离式启动；另一个进程可在同一运行目录使用 `status`/`cancel`。该工具绑定已评审的入口，不重新实现协调器。Spec 由操作者编写，因此 spec 路径不作为不可信输入处理。

2026-09-14，`ooo_round` 离开产品工具目录，因为普通协作不需要专用工具；见 `docs/design/task-unit-semantics-obligations.md` 的 G5。此前的工具与本历史记录都不能证明产品现有的 `nmg_board` host path 会调用抽取出的程序化 dispatch loop。

## S4：对照评估（历史记录；工具与离线臂于 2026-09-12 完成）

`cycle.ts` 增加 `mode: "ooo" | "sequential"`：两组使用相同 plan、输入、检查与验收规则，只改变派发顺序。Mode 成为轮次身份的一部分，replay 不能跨 mode。

`round-compare.ts` 与 `round-cli.ts compare --runs N` 运行两个 arm，各自使用独立 store、logs 与 records。报告质量（`verdicts`/`accepted`）、wall time、host 检查次数/耗时、被覆盖的等待、tokens、`cacheRead`、worker 检查、killed/survived、失败与 reopen。报告写明“两臂质量不同就不比较时间”；质量不一致时退出码非零。

**未完成 live-model 对照：**它需要 2×N 次付费轮次，并须获得操作者授权。离线臂重放已记录答案，使用零模型 tokens，只测量调度/host 开销。