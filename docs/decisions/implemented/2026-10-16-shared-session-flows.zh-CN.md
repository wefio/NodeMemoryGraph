# 共享会话流转归入集成层

[English](2026-10-16-shared-session-flows.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [harness 适配器即薄传输](../../../skills/nmg-memory/references/harness-adapters.md)

## Problem

召回守卫、有界会话任务窗口、工具结果观测、答案重叠归因、agent 身份、黑板唤醒
循环全部写在 pi 适配器（`.pi/extensions/nmg/index.ts`）里。harness-adapter
边界要求一切能力落在 `src/*` 或 daemon，第二个适配器应转发同一 RPC 而不是复制
逻辑；但这几条流转是 pi 独有代码。按此规则新增 OpenCode 适配器时，要么复制逻辑，
要么默默丢掉这些行为——按仓库自身定义两者都是缺陷。

## Decision

把流转逻辑移入 `src/integration/` 下六个宿主中立模块，行为逐字节保留，适配器
退化为绑定自身形状的传输与发射原语：

- `session-recall-flow.ts` — 每轮工具流守卫（`SessionRecallFlow`）。
- `session-task-window.ts` — 跨简短续接轮的有界任务锚点
  （`SessionTaskWindow`、`SessionRecallRequest`、任务提示分类）。
- `tool-observation.ts` — 消息展平、摘要截断、成功提交识别、值得记忆的结果
  过滤、trace 摘要。
- `agent-attribution.ts` — 诊断归因缓存与答案/提示文本抽取
  （`AgentAttributionFlow`、`extractAnswerText`、`extractPromptText`）。
- `agent-identity.ts` — 稳定 agent 身份的 load-or-create 与改名；兜底锚点由
  参数（`hostPrefix`）命名空间化，pi 传 `"pi"`。
- `board-wake.ts` — 唤醒配置/状态在调用方给定的数据目录下持久化、每日预算
  门、纯函数唤醒候选判定、候选收集、投递过滤、世界频道广播与投递，`invoke`
  与 `sendWake` 注入。

配套类型随之迁移：`TaskBoardToolEntry`/`TaskBoardToolResult` 进 `tool-contract.ts`，
五个 `NMG_AUTO_RECALL_*` 环境变量读取函数进 `config.ts`（全部以 `environment`
参数化，默认 `process.env`）。`piUserTurnKey`/`projectPiBranch`/证据源选择、
TUI、Shadow 桥、提示组合留在 pi 侧：那是 pi 的表面，不是共享流转状态。对应测试
移入 `tests/integration/session-flows.test.ts`；pi 适配器测试只保留 pi 自身接线
的行为。

## Alternatives considered

- 流转留在 pi，OpenCode 适配器复制一份。拒绝：复制的策略会漂移并陈旧——正是
  适配器边界规则点名的缺陷。
- 把这些流转推进 daemon RPC 表面。现阶段拒绝：回收窗口是每会话的进程内状态，
  预算在亚秒级；走 RPC 会增加一次往返和一个 daemon 重启边界，而这些状态本来就
  刻意做得廉价且在 idle 侧执行。
- 不参数化，在 pi 索引里 re-export 当垫片。拒绝：pi 仍是表观所有者，其他适配器
  看不到真实模块图。

## Consequences

- 每个 harness 适配器必须导入这些函数而不是重写：跳过 `collectWakeCandidates`
  的唤醒循环会静默丢失定向收件箱语义，因此能力矩阵（见
  `docs/design/harness-capability-matrix.md`）按函数级记录对齐。
- 适配器多出两个注入接缝（`invoke`、`sendWake`）和一个 `dataDir` 参数；pi 行为
  不变（迁移测试 50/50 通过）。
- `loadOrCreateAgentIdentity` 的兜底锚点现在按 `hostPrefix` 命名空间化，未来
  第二个适配器共享 session id 时不会串到 pi 的身份行。
- 能量代价是每次调用一层间接；各模块复杂度与 pi 源一致。

## Rebase 对账（2026-10-17）

本次落地以 rebase 方式并入 daemon 管线（#90），调和结果：

- 提案协议（`searchCueParams` / `recallSource` 观察守卫 / recall-gate lab
  流程）保留在 timing 线，不随本 PR 移植；原 pi 端 piggyback 测试随之删除。
  `beginDisclosureTurn` 不携带原始 prompt 的约束由 core 层
  （`tests/core/session-active-graph.test.ts`）与 service 层
  （`tests/cli/service.test.ts`）继续覆盖。
- `session-flows` 中文用例的措辞改为 daemon 管线 gate
  （`EXPLICIT_RECALL_PATTERNS`）可识别的形式；timing 线的额外 gate 校准
  （"来着"问式、`[你您]记得…` 问式）不在本 PR 范围。
- 环境注意：pi 适配器派生的 daemon 跟踪的是 `dist/cli/main.js` 编译产物，
  而非源码。全新 worktree 在 `npm run build` 之前运行召回类测试，会得到
  "No matching NMG memory found." 形式的假失败。
