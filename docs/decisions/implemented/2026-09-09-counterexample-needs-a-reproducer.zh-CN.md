# 反例必须带可复现输入

[English](2026-09-09-counterexample-needs-a-reproducer.md)

**Status:** implemented  
**Approved:** explicit  
**Relates to:** 2026-09-09-assertion-domain-and-strength

## Problem

今天有两种挑战声称的方式被同等对待：一种意见说「这看起来有问题」，一个输入说明「这条声称是
假的」。只有第二种是反例，但两者都没有通道，也没有任何工件记录「已经提出、尚未了结」的那一条。

缺的工件出现在停止条件里——所有证明义务关闭、所有有效反例解决、剩余假设与未覆盖范围写明。第一条
有 RTM 账本，第三条有假设册和 PR 的 `## 未验证项`。**第二条没有归宿**，所以一个被提出、被争论、
然后被搁置的挑战，随着对话结束就消失了。

2026-09-09 实测：本仓库观测到的验证失效**全都是相反的一类**——坏 oracle、目录 glob 抛
`MODULE_NOT_FOUND`、继承 `NODE_TEST_CONTEXT` 造成的假绿、文档声称未实现的工作。本项目从未记录
到成堆的 Agent 误报。所以这条规则针对的是一个**在这里没被观测到**的问题，下文如实写明。

## Decision

一个账本 `.rcp/counterexamples.yaml`，每个挑战一条：

```yaml
- id: ce-2026-09-09-001
  claim: apply-requires-harness-boundary
  status: open # open | resolved | unsubstantiated
  reproducer: | # status 为 open 时必填
    node --experimental-strip-types tools/agent-verify.ts -- .rcp/contracts
  observed: apply proceeded with no harness boundary
  resolution: # resolved 时必填
    revised the domain statement; the case was outside it
```

规则：

- `open` 条目**必须**带 `reproducer`——一条别人能跑的命令、输入或用例；
- `claim` 点名被挑战的是什么——断言 id、检查名、或某个文档。它**不必须解析得开**：针对还没进账本
  的东西提出的挑战，往往才是有价值的那一个；
- `unsubstantiated` 的存在，是为了让无法证伪的担忧能被记下来而不阻塞任何事，也不被包装成证据；
- 了结必须点名改了什么：产品、证据，还是某条 `domain` 声明。

格式非法的条目，或没有 reproducer 的 `open` 条目，会让 `docs:check` 失败。

## Alternatives considered

- **写在 PR 或对话里。** 否：对话会结束，而下一个 Agent 找未决挑战时不会去读那个 PR。
- **用 GitHub issue。** 外部报告长期该放那儿，但它们在仓库之外，`docs:check` 看不见；仓内账本
  不需要网络就能被 Agent 读到。
- **让模型自己给发现定级**（严重度、是不是真问题）。否：那等于让模型给自己当 oracle。要求
  reproducer 的要点正是**由报告者以外的人**来判定。
- **要求每个担忧都带 reproducer，不设 `unsubstantiated`。** 否：有些担忧确实不可证伪（「这个 API
  可能让人困惑」）。拒绝记录它们会丢信息，记成 open 又会永久阻塞。
- **要求 `claim` 必须解析到已登记的断言。** 否：最有价值的挑战往往针对**还没进账本**的东西，强制
  解析恰好会压掉它们。检查只要求 `claim` 有名字，不要求它解析得开。

**现在必须成立的：**

- 格式非法的条目让 `docs:check` 失败；
- 没有 `reproducer` 的 `open` 条目让 `docs:check` 失败；
- 空账本通过；
- `skills/verification-traceability/SKILL.md` 只写一次规则，并链接到本决策而不是重述它。

## Consequences

- `.rcp/counterexamples.yaml` 存在，内含一条已了结条目：`ce-2026-09-09-001`——route 级
  `node-test:<route>` 检查在 glob 一个文件都没匹配上时也会通过。`createResolver` 现在要求
  route 至少解析出一个文件才绑定，并有回归测试覆盖。
- `docs:check` 会在条目格式非法、`open` 条目没有 reproducer、以及 `unsubstantiated` 条目反而
  带了 reproducer 时失败。
- 停止条件的第二条有了归宿。
- 代价：多一个要维护的账本；reproducer 被记下却从没跑过，没有任何东西能发现。

## Risks

- **这条规则可能在回答一个本仓库没观测到的问题。** 这里测量到的失效全是假绿，不是过度报错。
  **撤销条件：若三个月内没有产生任何条目，删掉账本与这条规则。** 措辞修正与定义域那一列不依赖它。
- **reproducer 可以被记下而报告者从没跑过。** 账本无法验证执行；它记录的是义务，不是证明。
- **多一个要维护的账本。** 接受：它很小，而且是停止条件第二条唯一的家。
