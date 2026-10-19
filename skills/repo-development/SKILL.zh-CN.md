---
name: repo-development
description: 安全地修改、测试并提交本仓库。用于任何 NMG 代码、测试、CI、打包或仓库工具改动。
---

# 仓库开发

[English](SKILL.md) · [使用的术语](SKILL.terms.yaml)

保持工作流程精简、以证据为基础，并兼顾并行 Agent。代码和逻辑应易于维护。复杂度必须控制在 15 以内。

## 仓库治理

- 将仓库视为 Agent 的工作环境。重复任务难以路由或验证时，应改进其现有 owner、路由或 Skill，而不是添加私有变通方案或另一事实来源。
- 将 Agent 的完成声明视为提案。定向测试、独立验证、干净 CI，以及（当改动跨越外部边界时）真实集成运行，决定改动是否成立。每项证明只适用于它实际测量的范围。
- 只通过明确的生命周期操作推进工作、PR、决策、防护规则和发布。不要从“完成了”或“发出去”等说法推断状态转移，也不要绕过前置条件。
- 积极发现熵：过时临时工作、过期防护规则、重复测试、未使用的兼容层和被取代的抽象。只自动移除生成物、缓存或明确设有过期时间的材料；删除源码、历史、公共接口、issue 或 pull request 前，先提出可审查的候选项。
- 限制仓库开销：除非任务明确要求，否则绝不调用 live LLM、embedding 或完整 benchmark 工作负载。
- 每项事实只设一个权威写入者。通过 GitHub、Contracts、仓库状态、验证 receipts 和 NMG memory 各自的 owner interface 观察或引用，不要复制到相互竞争的存储中。
- 在共享或并行 Agent worktree 中，提交前先隔离。先运行 `git status --short`：其他 Agent 的未提交改动或在你操作期间移动的 HEAD 都表示这是共享树。不要在共享树运行 `git add -A` 或 `git commit -a`；只暂存自己负责的路径。worktree 正在被共享时，优先用专用 `git worktree add` 承载自己的改动，只提交自己的文件，并通过只还原自己相对于 HEAD 的文件把共享树交还。悄悄吞并其他 Agent 工作树内容的提交属于协作失败，不是合并。改动落地或放弃后，移除专用 worktree 及其分支（`git worktree remove <path>`，然后 `git branch -D <name>`），避免废弃 worktree 累积。

## 编辑前

1. 根据[发现协议](../../AGENTS.md#find-the-context-for-the-next-action)定位目标及其 owning contract。所有权或检查不清时，使用 `npm run agent:context -- <target-path>`。其 owner paths 是查询候选，不要求通读整个文件。位置参数用于指定明确范围；`--changed` 会加入 Git dirty paths。Reconciliation `unknown` 表示缺少适用证据；`drifted` 表示应检查报告中的不一致。两种状态都不是架构结论。
2. 检查 `git status --short`；保留无关改动，只提交自己负责的文件。
3. 阅读适用的 owning design 部分和将要修改的准确代码。文档或流程改动遵循 [doc-maintenance](../doc-maintenance/SKILL.zh-CN.md)；一次性脚本或临时分析遵循 [script-reuse](../script-reuse/SKILL.zh-CN.md)。
4. 说明可测试的结果。修复缺陷和生命周期问题时，先写失败行为测试。
5. 在第一次实质性文件写入之前，必须在 `repo-development` Task Board channel 登记一个开放的 in-flight goal。内容只能包含 `goal`、`approach` 和 `scope`；一个连贯任务只用一个条目，不按文件或步骤拆分。遵循 [`nmg-memory`](../nmg-memory/SKILL.zh-CN.md) 的 daemon 所有权规则，并保留返回的 entry ID：

   ```text
   nmg board put repo-development \
     "goal=<outcome>; approach=<intended method>; scope=<owned paths>" \
     --agent <stable-agent-id> --kind goal --ttl-seconds 86400 --json
   ```

   不要发布进度更新。Writer attribution 标记初始 worker；需要接手时，另一 Agent 可以 claim 同一个开放条目。如果由于本任务正在修复 NMG lifecycle 或 board code 而导致 board 不可用，报告此限制并继续，不要让仓库变得无法修复。

## 测试分类

- **Safety：** 防止数据损坏、泄漏、不安全删除或安全回归。阻塞 CI 且长期保留。
- **Contract：** 保护公共 API、协议、package、持久化或受支持的集成。阻塞 CI 且长期保留。
- **Guardrail：** 在设计修复期间暂时阻止已知回归。放在 `tests/guardrails/<id>/`，并带 `guardrail.yaml`；记录 `reason`、`review_after` 和 `exit_criteria`。
- **Characterization/research：** 测量当前行为或假设。不得重新定义产品正确性，并且在 CI 中不阻塞。

不要无意中把临时测试变成永久架构。满足其退出条件时，将其提升为 safety/contract 测试，或移除。

## 实现与验证

1. 做最小的连贯改动；可选基础设施放在窄接口 adapter 后。新增或修改环境 gate、mode flag 或非默认功能时，同次改动遵循[隐藏功能登记规则](../../docs/decisions/implemented/2026-09-07-register-hidden-features.zh-CN.md)。
2. 行为或流程变化时更新 owning design。非平凡改动还须在同次提交中新增或更新至少一条 `docs/decisions/` 记录。非平凡包括改变行为、跨文件或 package 共享的 contract、package/module 结构、流程/工具、测试策略或磁盘/wire/configuration 格式；格式调整、注释措辞、错字修正和无行为变化的依赖升级除外。遵循 [`doc-maintenance`](../doc-maintenance/SKILL.zh-CN.md)。
3. 先运行定向测试，再运行 `npm run agent:verify`。不带参数时，它会自动检测 Git 改动、选择路由、执行确切的阻塞检查，并用结构化证据覆盖 `.nmg/verification/latest.json`。共享 dirty worktree 中传入 `-- <owned-path>`，将无关改动排除在计划外。只有在有意承担研究或 chaos 成本时才使用 `--include-advisory`。
4. 长检查应 detached 运行，并在提交前收集。便宜且具有决定性的检查——被改文件的 LSP diagnostics、format、lint、`complexity:gate`、`docs:check`——保持同步运行；代价较高的三项——完整 `mutation:teeth`、`test:product`、`evals/**` suites——在被测代码定稿后立即启动，同时撰写文档并运行便宜的检查：

   ```bash
   { echo "started=$(date -Is)"; echo "snapshot=$(git rev-parse HEAD)"; } > .temp/x.state
   (npm run X > .temp/x.log 2>&1; echo "exit=$?" >> .temp/x.state) &
   echo "pid=$!" >> .temp/x.state
   ```

   每次启动都应是独立语句，header 在前台运行：`A && B &` 会把整个列表放到后台，导致 state file 被截断在 `pid=` 行后面——这是唯一不能读取的 state。

   启动后立即返回，之后不等待——不 `sleep`、不循环轮询、不偷看它是否已经值得读取：collector 会在下一个自然检查点读取文件，其间把时间用于改动的其他部分。如果没有其他工作，就同步运行检查。

   **Detached run 的 state 有三种结果，不是两种。** _Finished：_ state file 有 `exit=<code>`，该 code 就是结果。_Still running：_ 还没有 `exit=`，且记录的 pid 仍存活（在后续 shell 中运行 `kill -0 <pid>`）；经过时间不是状态，因此不能把运行时间长读成失败。判断仍在工作还是卡住，应查看检查本身的进度，而非时钟。不同检查的进度信号不同，不能互换：npm test lane 会逐项输出 TAP；`mutation:teeth` 只在最后写 summary——其运行中的信号是 lock file 的 `target`（随每个 target 推进），以及替换和恢复文件时 target file 的 mtime。用错进度信号会把正在运行的 sweep 误读为卡住。
   _Died：_ 没有 `exit=` 且 pid 已消失，因此没有进程写入 code——运行被终止，而且可能在树中留下 mutant；lock 会标出 target，应先对它运行 `git diff`。

   Detached run 会记录它测量的树，collector 会将记录与当前树比较：代码变化后必须重跑。mutation run 正在改写的文件不得编辑或暂存——运行期间 `git status` 会把当前 target 显示为 modified，其中含有 live mutant；此时暂存的是 mutant，不是工作。改动期间的 scoped `--targets=` run 和 push 前的一次完整 run 回答不同问题。测得成本与陷阱见[该决策记录](../../docs/decisions/implemented/2026-09-18-detached-long-checks.zh-CN.md)。

   **运行中的 sweep 会让树不可读，而不只是不可写。** 从替换 target 到恢复 target 之间，目标文件本身_就是_ mutant，因此此窗口运行的 `lint`、`complexity:gate` 和其他检查都针对 mutant——即使检查**通过**，证据也只属于从未存在过的代码。Sweep 现在会在树中声明此状态（`.temp/mutation-lock.json`、`tools/mutation-lock.ts`）；lock 存在时 `npm run agent:verify` 会拒绝运行，而不是检查 mutant；`npm run agent:context` 会报告它。不要从记忆重新推导：这一整类失败见[事后复盘 0003](../../docs/postmortem/0003-checks-read-a-live-mutant.zh-CN.md)。

5. 研究 adapter 只用 `npm run test:research`；显式生命周期故障测试用 `npm run test:chaos`。两者都不能代替产品测试。
6. CI、打包或生成输出改动（见[构建与生成产物](references/builds.zh-CN.md)）应在干净 checkout 上验证，或在等价干净树中使用 `--require-clean`。CI 会在 push 和 pull request 时自动运行命名的 `verify:*` package contracts。
7. 一次提交只包含一个连贯改动和自己负责的文件。提交信息遵循仓库 conventional style（`type(scope): summary`，正文说明改变内容与原因；每次提交一个改动）。提交是提案，不是证明：验证证据（定向测试 + `agent:verify`）才让改动成立，所以没实际运行的检查不能写成已通过。证据没有第三种状态：不能复现的失败，要记录复现尝试和频率，或保持未解决——绝不能用“flaky”标签关闭一个尚无人回答的问题（[事后复盘 0004](../../docs/postmortem/0004-flaky-was-a-clock-boundary.zh-CN.md)）。
8. 开 PR 时先读 `.github/pull_request_template.md`，并按它填写 PR：根据改动和 `未验证项` 写完三个描述块（What / Why / Changes）。`未验证项` 应列出改动未覆盖的表面——未运行的路由、未构建或启动的平台/环境、build mode，或没有 reproducer 的行为。只有确实没有遗留项时才写 `None.`。这项声明界定范围；它不能替代检查，绿灯 gate 也不使它变得多余。然后在将 PR 标为 ready 前自行检查完成清单中的每一项——该清单与 CI 执行的是同一 contract，可在本地发现 CI 往返才会发现的问题。Draft PR 和 CI 状态由 forge 管理；模板清单是提交者自己的 pre-flight，不能替代 `All checks passed`。
9. 任务完成或明确放弃后，resolve in-flight goal。Board 记录工作是否活跃，不记录逐步历史；Git 和验证证据仍是实际实现状态的来源。

## 何时阅读操作手册

上文是普通改动会走的路径。只有特定类型改动需要了解以下两个主题：

- 对 `agent:verify` 不覆盖的 RCP 操作（forge status、plan/compile、receipts、显式 reconcile、PR binding），以及默认不扫描超大树的规则：读[控制平面](references/control-plane.zh-CN.md)。
- 构建本仓库、重新生成输出、安装子 package 或处理 lockfile drift：读[构建与生成产物](references/builds.zh-CN.md)。