# 召回意图与有界降级诊断

[English](2026-10-10-recall-intent-and-diagnostics.md) · [术语](2026-10-10-recall-intent-and-diagnostics.terms.yaml)

**Status:** implemented
**Approved:** auto
**Relates to:** [共享信息输出](2026-10-07-shared-information-output.zh-CN.md)

## Problem

新会话对比同时改变了扩展加载方式和问题：普通加载使用显式召回词表遗漏的“先前”，显式加载使用已识别的“之前”。该对比不能把未召回归因于扩展发现。

降级搜索还把 embedding 供应商的完整错误正文、配额细节带入模型可见候选。另一个独立缺陷是成功的关闭归档保留五秒 deadline，写入完成后仍让 Node 存活。

## Decision

在共享 memory gate 补齐同义词，不增加 Pi 专属判断；保持无需记忆轮次及既有召回上限。

2026-10-14 的有界诊断沿用此决策，补充无时间前缀的中文回忆问句：带疑问标记的“你记得／您记得”和“来着？”。只匹配问句形式，不笼统匹配“记得”或“来着”子串，避免把提醒、着色指令识别为这些新增召回线索。[匹配条件的词法回放](../../experiments/retrieval-quality/shared-recall-entry-diagnosis-2026-10-14.md)把丢失层定位在搜索之前，不能据此调排序或检索预算。

在紧凑投影和渲染边界规范化降级原因：保留已知 embedding/index 代码或 HTTP 状态代码，未识别诊断用 `unknown`。原始结构化结果与 daemon 健康诊断不变；空的降级结果也保留词法回退信号。

归档在 `finally` 释放 deadline，包括成功完成。停滞写入仍 staging，等待上限和 daemon 所有权规则不变。

规范由 [Agent Surface 与渐进召回](../../design/design.md) 和 [会话关闭](../../design/session-memory-lifecycle-hooks-2026-08-10.md#3-不变的钩子) 维护。

## Alternatives considered

- 根据两次历史运行修改扩展发现：问题没有触发同一 gate 决策，拒绝这种归因。
- 删除供应商诊断或省略降级提示：操作者和读者需要不同的诊断、召回健康信号，拒绝。
- 截断任意供应商文本：仍会带入未批准内容，也缺乏稳定原因标识，拒绝。
- 延长 smoke 超时、留下归档计时器：已完成工作没有理由继续保留 deadline，拒绝。
- 修改 Pi 或安装传输观测器：这些修复不需要。

## Consequences

共享 Core 和呈现修复可供普通工具及 RPC 消费者使用；Pi 保留既有公开钩子。不增加执行器、schema、状态库、环境开关、供应商请求策略或披露确认。

确定性回归区分召回同义词、保留完整来源诊断但不复制到显示、保持空结果健康信号，并验证 deadline 清理和停滞写入 staging。它们不证明每个历史启动或进程超时的原因。

## Deferred

原来的 97–152 秒模型调用前区间缺少分阶段观测。归档计时器回归只覆盖有界的写入后延迟，不解释这些区间，也不保证整个 Pi 进程退出。原生 SDK 准备和完整 CLI／模型／退出运行是不同的证据边界。
