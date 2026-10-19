# OoO 研究探针的 MAST 失败模式标注

[English](mast-coverage-2026-09-12.md) | [简体中文](mast-coverage-2026-09-12.zh-CN.md) · [术语](mast-coverage-2026-09-12.terms.yaml)

**Related:** [设计](../../design/ooo-execution-bootstrap.md) ·
[等待的价值](wait-value-2026-09-12.md) ·
[admission run](../ooo-admission-2026-09-08.md) ·
[MAST 分类法](https://arxiv.org/abs/2503.13657)

2026-09-12 观察，零模型 token：这是对已存在证据的标注，不是一次新的 run。它是在价值问题从墙钟时间转向失败模式发生率之后被要求的。

## 证据基础

这是历史研究 driver 的评估，不是产品 Task Board 契约，也不是自然失败发生率下降的测量。
所引日志、mutant／套件计数及源码字节／标题计数均为历史报告，不是本轮重开产物或重跑测试。
[Admission 报告](../ooo-admission-2026-09-08.zh-CN.md#问题与范围)拥有探针边界；已退役的 round
工具不定义当前默认值。下述外部 MAST 与 code-RL 声称未重新联网核验。

- 七个 live 轮次与三次 promotion（`docs/experiments/ooo-admission-2026-09-08.md`）、round-7 日志（`.nmg/ooo-live/round.jsonl`：23 个事件、10 个已声明 mutant、9 个存活、1 个被杀死、无 reopen、无 pushback、无 worker 失败）、`.nmg/ooo-live/rejections.json`、两次无模型调用的真实 replay，以及 cancellation／多进程套件。
- 原记录引用 MAST（arXiv 2503.13657）为：三个类别下的 14 个失败模式，来自七个开源框架上的 200 条对话轨迹。原审阅未取得各类别百分比（当时报告项目页／arXiv HTML 未给出）；这不是新调查，也不证明今天仍无这些数字。此处不引用频率。
- MAST 的轨迹是对话式 planner／worker／reviewer 系统，其对话层面模式不直接映射这个冻结 envelope、无对话的研究路径；这是本标注的范围，不是所有 Task Board 用户都没有对话的声称。

## 标注

以下标签分类所引机制／证据，不是观察到的防止率；`blocked` 尤其只是有范围的守卫主张，
不是完整行为合规、OS 隔离，也不证明自然违规曾被拒绝。

| MAST 模式                             | 判定                              | 机制与证据指针                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 disobey task specification        | blocked                           | digest 绑定的 envelope 携带可编辑／可见集合、已准入结论、案例规则与预算。手写结论缺少 `kind` 判别字段时，会以 `invalid patch structure` 被拒绝。                                                                                              |
| 1.2 disobey role specification        | blocked（机制）                   | worker 从不是 approver；只有宿主验收。多进程与 cancellation 套件。**无样本**：所引轮次记录未包含这种 worker 尝试。                                                                                                                                      |
| 1.3 step repetition                   | blocked，附带一个反事实           | attempt／fencing 代数；「reissue fences old execution」。mutant `reopen-keeps-attempt`（reopen 但不推进代数）在基线上存活，并被 round-6 候选杀死。                                                                                           |
| 1.4 loss of conversation history      | 不适用                            | 本探针路径不建模 peer 对话；任务上下文存在于冻结的 envelope 中。                                                                                                                                                                                                                                         |
| 1.5 unaware of termination conditions | blocked                           | `cancel(reason)`、`abandonCheck`、`cancelled`、从不报告的检查按 `undecidable` 终止，以及在前提未测量时拒绝派发——`rejections.json` 保存了两条记录，内容为「B not dispatched: B's declared fault could not be measured」。`recovery.test.ts`，8 个测试。 |
| 2.1 conversation reset                | 不适用                            | 本探针路径不建模 peer 对话重置。                                                                                                                                                                                                                                                                               |
| 2.2 fail to ask for clarification     | 部分                              | 存在 `cannot-complete` 退出；这个固定协议没有类型化澄清通道，与更广的 board 协调分开。                                                                                                                                                                                                                               |
| 2.3 task derailment                   | 部分（无样本）                    | 可编辑／可见集合、预算与限制会拒绝越界编辑（S0 负例）。零记录样本。                                                                                                                                                                                   |
| 2.4 information withholding           | 部分，仅机器侧                    | 串行的可操作 entry 槽位：一条 stale、未被 claim 的 handoff 占住该槽位并阻塞了其后所有 claim（已在 PR #45 修复）。无 worker 侧机制。                                                                                                                                                   |
| 2.5 ignoring peer input               | 部分                              | Composition 消费 A 与 B 的已验收 artifact；此 composition 路径没有直接 A／B peer 对话通道。                                                                                                                                                                                                                     |
| 2.6 action-reasoning mismatch         | blocked（机制）                   | 结论必须携带对冻结来源可解析的引用，并遵循案例与 token 规则；`check-events.test.ts`（10,752 B，17 个标题）。**无样本**：round 7 记录到零拒绝。                                                                                                   |
| 3.1 premature termination             | blocked                           | 前提未测量时不接受成功完成报告（`premise-unmeasured` 会中止该分支），且 composition 验证必须先完成。来源：一次在已为假前提上花掉 204,164 token 的轮次产生了 premise-before-dispatch 规则。                                                                 |
| 3.2 weak verification                 | 部分——被暴露，未被消除            | mutation 矩阵把「验收规则能否杀死这个故障」变成机械判断。Round 7 结束时 10 个 mutant 中有 9 个存活；在 promotion 复测之后，2 个被杀死，5 个仍存活。                                                                                    |
| 3.3 no or incorrect verification      | blocked                           | 宿主是唯一验收权威，且文本通道传递同一 envelope；四个 S3 缺陷之一是文本答案被原样记录，因此宿主只能在付出成本之后才拒绝它。                                                                                         |

统计：7 个 blocked，5 个部分，2 个不适用——这是标注标签数，不是已阻断事件或独立试验数。

3.2 行保留 9／10 存活及后来的 2 个被杀死／5 个存活，但总体衔接未说明；若从该 9 个扣除
2 个，应余 7 而非 5。本记录不建立这种同总体解释，也未对账差异；不能补造额外杀死、
排除项或改善率。

## 分类法之外，以及归因更正

Peer 占用、staging 边界摩擦与沟通没有出现在 MAST 中，而一天的三 agent 工作确实产生了一个真实样本：我的 diff 里出现了属于另一个 agent 的六个文件；会话中途的一次 `git checkout` 把共享 worktree 移到了另一个分支；本地 `main` 是 stale 的（`df7456cd` 对 `8a099905`）；为避免碰到他人未提交的工作，用了两次 blob surgery 和三个临时 worktree；此外另一个 agent 用 board 通道谈成了 `docs/design/design.md` 的 staging 边界。

该样本最初在这里被报告为设计覆盖范围的缺口。**那是错的。** 摩擦发生在任何轮次之外：计划为每个任务分配互不相交的可编辑集，宿主是唯一写入者并在一次性候选 worktree 中工作，handoff 与 claim 都发布在 board 上，而 board 就是沟通通道。在所引的已准入研究路径内，排除依赖互斥可编辑集、唯一权威写入者及隔离的候选 worktree；它不是 OS 沙箱，也不保证外部写入者或其他协调者不会碰撞。两个诚实的残留问题：沟通存在但被我闲置，而不是缺失（另一个 agent 确实在 board 上谈成了 staging 边界）；另有一处边界确实未受保护——**promotion**，即已验收候选从一次性 worktree 进入共享树（那两次 blob surgery 正是这种情况），以及轮次之间的窗口，此时两个协调者或一个长期未提交的文件处在任何计划之外。

原审阅无法从所检查的历史推导碰撞率：只有一个提交身份，squash-merge 使分支被报告为未合并，rebase 重放把两次尝试夸大了数个数量级（785 文件／151,759 事件，随后 472／1,406，两者都被我自己的堆叠历史主导）。该检查点报告尚无插桩，不是本轮全仓插桩审计。

## 未建立的内容

- 机械守卫及构造负例不建立自然防止率；尤其 1.2、2.3 与 2.6 没有所引 live 违规可拒绝。
- 原记录把 3.2 视为最尖锐弱点，并引用外部观察：code-RL 环境中 28.5 % 的任务其测试套件弱到能被 Docker 验证通过的错补丁也通过。这个不同任务总体／分母不是本探针的定量佐证或可迁移发生率。
- 适用于任务板设计的那 12 个模式是否真的是多会话 agent 工作中实际发生的模式，未被测量；所引多进程 fixture 使用分别启动的进程中的脚本 actor，不是独立由模型驱动的参与者；进程分离真实存在，但不等于行为独立。
