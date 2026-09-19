# 让"检查身份"与"检查运行器"各自叫自己的名字

[English](2026-09-19-name-the-check-and-runner.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [给 integration 层配路由](2026-09-19-route-the-integration-layer.zh-CN.md)

## 问题

`src/integration` 下有两个文件带着一个对读者毫无信息量的 `ooo-` 前缀：`ooo-check.ts` 只有 38 行、装着一个身份类型（`CheckTicket`，即宿主签发的某次外部检查的身份），而 `ooo-verifier.ts` 才是真正跑检查并给结果的那个。两个名字都没说明谁是身份、谁是运行器。

## 决策

只改这两个：`ooo-check.ts` → `check-ticket.ts`，`ooo-verifier.ts` → `check-runner.ts`。其余六个 `ooo-*.ts` 保持前缀，这一层保持扁平。

## 考虑过的替代方案

- **把整个子系统从 `ooo` 改名。** 否决：这是本项目给自己实现的调度模型起的名字，且它在**一百多个文档**里承重——`docs/design/ooo-execution-bootstrap.md`、各决策记录、以及 `docs/experiments/execution/archive/` 下冻结的运行归档。改代码会让每一份历史记录都引用不再存在的路径，而那些归档是证据，不是草稿。
- **把子系统收进 `src/integration/ooo/`，让名字只说一次。** 暂缓：这是一次覆盖约八十条 import 边的结构移动，而两条新 route 已经让这一层的各部分可见，不必搬文件。
- **什么都不改。** 否决：这两个名字正是读者必须打开两个文件才能解码的那一对。

## 后果

改了六个文件，没有文档引用需要修（本来就没有），对外接口没变——这两个名字从未出现在任何 CLI 命令或工具名里。`docs/experiments/ooo-admission-2026-09-08.md` 仍在正文里写着旧路径：那是带日期的测量记录，按原样保留。

这一层的 route 是**逐文件**声明而非通配，所以这两个改名必须在同一次改动里落到 `agent-context.yaml`；随那两条 route 一起加的测试，会在 `src/integration` 下出现任何未被认领、也未被点名为已知缺口的文件时失败。
