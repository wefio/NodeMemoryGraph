# 一个接受谓词，由该轮执行路径共同采用

[English](ooo-acceptance-predicate-2026-09-13.md) | [简体中文](ooo-acceptance-predicate-2026-09-13.zh-CN.md) · [术语](ooo-acceptance-predicate-2026-09-13.terms.yaml)

**相关：**[Task-unit 语义设计](../../design/task-unit-semantics.zh-CN.md) · [决策记录](../../decisions/implemented/2026-09-13-task-unit-semantics.zh-CN.md) · [切片 1：compiler 与 model](task-semantics-slice1-2026-09-13.md) · [Board deliverable/verdict 决策](../../decisions/implemented/2026-09-06-board-governance-addressing.zh-CN.md)

测量日期：2026-09-13。没有模型 token：下列数值来自确定性的 round suites 与 mutation teeth，没有调用 provider。

## 问题

设计规则要求一个事实只有一个谓词：“接受查询与依赖解锁必须调用同一谓词……不得一条路径看 board verdict，另一条仅检查 artifact 非空。”本轮实际是否违反此规则？如果是，在哪个可达状态，而不只是措辞重复？

## 实际问题

该 round 对“accepted”保留了两种定义。`accepted()` 同时检查 board verdict 和 digest；四条调度路径只检查 artifact 列非空：`inputs()`（依赖绑定什么）、`publishReady()`（哪个 handoff 可占用 board 的串行槽）、`next()`（选择任务）和 `claimableRow()`（claim 是否可接受）。

正常 round 中两种定义一致，因为 `commitArtifact()` 是 `artifact` 的唯一写入者，且仅在 host verifier 接受、coordinator 判定 `accepted` 后写入。两者只在一种可达状态中分歧：**外部 reviewer 重新判定已交付条目**。Board protocol 允许这种操作（该 round 自己也使用同一 `judge` verb）；`accepted()` 上的设计注释也预见了后果——条目 verdict 被判 rejected 后，“即使值仍保存，也不再算 accepted”。因此，round 可能继续释放依赖于一个已有记录 verdict 已拒绝的产物，而调度路径看不到该 verdict。这是缺陷，不是风格上的重复。

## 改动

| 位置 | 改动前 | 改动后 |
|---|---|---|
| `src/integration/task-semantics.ts` 的 `acceptedFact()` | — | 唯一规则：未 cancelled、artifact 与 digest 存在、revision 当前、verdict 为 `accepted`、`judgedDigest === digest` |
| `isAccepted()`（view） | 自有一份规则 | 委托给 `acceptedFact()` |
| `src/integration/ooo-board.ts` 的 `acceptedArtifacts()` | `accepted()` 查询另加自己的 verdict 检查 | 一个查询提供事实给 `acceptedFact()`；`accepted()` 委托给它 |
| `inputs()`、`publishReady()`、`next()`、`claimableRow()` | `artifact !== null` | 检查是否属于 `acceptedArtifacts()` |
| `delivered(row)` | — | 只在问题确实是交付事实时命名（`submit`、`commitArtifact`、check guard） |

## 行为

- 外部 rejection 现在会**撤销依赖任务的放行**：`next()` 不再选择依赖任务，claim 失败并返回 `unfulfilled dependencies`。
- Round **失败关闭，不会自行修复**：被拒 artifact 仍然已经交付，因此任务不会被静默重跑。Claim 会说明“task delivered but not accepted; the coordinator must reopen it”；恢复由 coordinator 显式调用 `reopen()`，并 fence 任务及其传递依赖、清除值。
- **不做 rollback。**已基于 artifact 派发的工作若之后被拒，不会被撤销；round 没有 rollback，本次改动也没有添加。改动统一的是 gate，因此 offline model 的 `fused` mode 会记录这笔成本，而不是假定成本不存在。

## 证据

| 检查 | 命令 | 结果 |
|---|---|---|
| types／lint／format | `npm run check`、`npx eslint …`、`npm run format:check` | clean |
| complexity | `npm run complexity:gate` | `6 changed code file(s) … 0 method(s) above 15` |
| round suites | `node --experimental-strip-types --test --test-concurrency=1 "evals/ooo-execution/*.test.ts"` | 86 pass，0 fail（原为 85，新增一个 case） |
| compiler／model | 两个 slice-1 suites | 13 和 7 pass（compiler 原为 12，新增一个 case） |
| mutation teeth | `npm run mutation:teeth` | 3 个目标共 11/11 mutants 按名称捕获；每个目标均逐字节恢复 |

新增 round case 在一个测试中复现缺陷：提交已接受 artifact，确认 `next()` 选出依赖任务，再由外部 Agent 将 board entry 判为 `rejected`；随后断言 accepted 集合为空、没有任务被选中、依赖任务不能 claim、被拒任务不能再次 claim，而 `reopen()` 会使其重新可调度。

## 失效的旧 mutant

`isAccepted()` 改为委托后，旧 mutation tooth 锚定的 `return` 行不再匹配。脚本报告 `anchor not found, refusing to claim a check` 并令本轮失败，而不是把缺失锚点当作通过。若 mutation harness 静默跳过已无法应用的 tooth，它可能继续报告看似令人安心的数字，却不再覆盖原检查；将 tooth 改锚到规则的新位置才保持了计数可信。

## 未覆盖事项

- 设计中的 retention 前置条件未改：被保留 run 引用的 board entry 仍受普通 TTL prune 影响，旧 run 的证据可能过期。
- `ooo_probe_tasks` 仍混合不可变输入（`input`、`revision`）、候选字节（`artifact`）和可推导状态（`entry_id`、`accepted_entry_id`、attempt counter）。本次只统一推导，不拆分存储；后续切片才处理共享事务 store、多轮命名空间和最小 manifest／facts。
- 没有接入新的 runtime path：round 仍拥有私有 SQLite store，compiler 仍只供 model 与这些 suites 使用。

## 复现

```bash
cd <worktree on this branch>
npm run prompts:generate
npm run check && npm run complexity:gate && npm run format:check
node --experimental-strip-types --test --test-concurrency=1 "evals/ooo-execution/*.test.ts"
node --experimental-strip-types --test --test-concurrency=1 tests/integration/task-semantics.test.ts
npm run mutation:teeth   # 同一批 mutants，现在是仓库工具
```