# 共享任务黑板

[English](board.md) · [术语](board.terms.yaml)

临时跨 Agent 协作或仓库进行中登记表请读本参考。普通的单 Agent memory 操作不需要 board。

需求使用原型词汇描述时，先查[现有操作映射](../../../docs/guides/board-concept-reuse.zh-CN.md#先使用已有基础)。
候选概念另行记录；这不授权新增协议对象，也不把事件关联变成可执行任务。

## 可用性与身份

面向模型的 board 和自动唤醒轮询默认可用，因此新 Agent 可以立即发现共享工作。只有当宿主明确要求单 Agent、仅记忆界面时，才设置 `NMG_ENABLE_COORDINATION=0`（也接受 `false`、`off` 和 `no`）。即使关闭模型侧界面，CLI board 操作仍可用于管理。

协作 Agent 对同一项任务使用稳定的 `TASK_ID`，并通过 `--agent` 标明身份。

## 进行中登记表

在仓库开发中，可以将一个 open 的 `goal` 条目作为进行中工作登记表。在首次实质性写入之前只创建一次：

```text
nmg board put repo-development \
  "goal=<outcome>; approach=<intended method>; scope=<owned paths>" \
  --agent scout-a --kind goal --ttl-seconds 86400 --json
```

该条目只回答要完成什么、计划如何完成以及涉及哪些路径。不要发布逐步进度、已完成项清单、工具轨迹，或为同一项连贯任务重复创建登记。写入者归因记录最初工作者；工作者不需要为自己的新条目额外声明认领。替代工作的 Agent 应认领尚未关闭的条目，检查 Git 和验证证据以确认实际进度，然后继续。工作完成或放弃时关闭该条目。

## 读取与关闭

只有在确实需要独立的 goal、blocker、question、result、handoff 或 decision 时，才创建额外条目。保持发布内容简短。增量读取时保留返回的 task-local cursor：

```text
nmg board read TASK_ID --agent scout-b --after-cursor 12 --json
```

显式关闭已完成或过时的条目：

```text
nmg board resolve TASK_ID ENTRY_ID --agent scout-b \
  --resolution "work completed or deliberately abandoned" --json
```

## 事件内的阶段协商

显式协商阶段时，沿用 `eventUpdate`，使用 `phasePropose`、`phaseAgree`、
`phaseSwitch`、`phaseWithdraw`，并提供 `proposalId`、`expectedPhaseRevision`
（首次切换前为零）和当前事件 `expectedRevision`。
提议另提供 `target: discussion|execution` 与可选 `requiredApprovers`；
默认确认人为当前参与者，始终包含提议者。每次写入后重读事件获取当前修订。
确认、撤回与提案 ID 复用规则见[阶段契约](../../../docs/design/board-event-records.zh-CN.md#范围级协作阶段)。
阶段状态不授权工具，也不停止在途工作；讨论候选和执行请求先用关联范围的普通消息记录，
实际行动等待另行约定的授权。

## 记忆边界

Board 是 task-scoped 协作存储，不是语义搜索、STG、LTG 或共享 AG。每个 Agent 将相关条目读入自己的私有 AG。条目可记录 goal、blocker、question、result、handoff 和 decision；不得记录秘密或隐藏 chain-of-thought。条目会过期；只有通过独立且有证据的 `nmg remember` 调用，持久结论才进入长期记忆。
