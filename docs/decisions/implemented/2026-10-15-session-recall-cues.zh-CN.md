# 仅当前会话的召回词组试点

[English](2026-10-15-session-recall-cues.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [召回意图](2026-10-10-recall-intent-and-diagnostics.zh-CN.md)

## Problem

固定入口规则会漏掉隐含的历史信息请求。用户无法提供成规模人工标注，
也不接受额外驻留深度模型的内存开销，并选择先仅在当前会话试用，
而不是跨会话保存规则。

## Decision

现用主 LLM 通过显式搜索补救，再使用共享 `recall_gate` Lab 能力提出字面词组。
租约和有界内存缓存将这类试验数据与记忆事实、候选相关性学习分开。
修订号将纠错绑定到所报告的未搜索输入，但不证明 LLM 的意图判断正确。
匹配、预算和生命周期由[检索规范](../../design/design.md#session-only-recall-cues)定义，
参数由[操作手册](../../../skills/nmg-memory/references/optional-capabilities.md#recall_gate-operations)说明。

Pi 转发原生回合输入并消费共享决定；MCP、DSH 提供相同 Lab 操作，
不据此宣称其自动上下文生命周期等价。不增加模型或每轮独立 LLM 评判调用。

## Alternatives considered

- 跨会话或全局规则：不在用户选择的范围内，试点错误不转成永久行为。
- 将生成的正则直接追加到源码：不具备会话边界和简单撤回能力。
- 训练分类器：增加用户不接受作为前置条件的数据准备和部署需求。
- 将模型自信度或回答重叠当标签：混淆意图、相关性和事实支持。

## Consequences

新问法仍依赖主模型主动使用工具。保守词法排除可能漏掉有效请求，
学到的词组也可能带来噪声。默认关闭和可撤回限制影响范围，
不把缓存升级为真实性或权限权威。

固定 fixture 验证显式补救、后续复用、撤回、隔离和租约生命周期，
不证明自然 LLM 自纠错、provider-send、精确率或成本改善。

## Deferred

自然使用观察、低预算词法对照、TARG 类不确定性信号和跨会话提升属于后续独立试验。
本次不包含 live 模型评测、共享 daemon 换代或默认启用。
