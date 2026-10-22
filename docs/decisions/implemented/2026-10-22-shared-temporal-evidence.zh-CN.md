# 协议边界上的共享时间证据

[English](2026-10-22-shared-temporal-evidence.md) · [Terms](2026-10-22-shared-temporal-evidence.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

NMG 已有 `eventTime` 存储、精简检索投影中的时间保留，以及共享 Agent Surface 的时间展示。本地 OmniMemEval 桥使用该界面，但 AML 响应只被拼成 `content` 时，历史时间锚点可能在进入答案模型前丢失。再建时间存储，或另写 benchmark 专属渲染器，会扩大产品与评测之间的差距。

## 决策

复用现有时间数据模型。[产品检索合同](../../design/design/progressive-retrieval.zh-CN.md#时间证据展示)拥有纯文本条件展示规则；[AML 集成边界](../../../evals/omnimemeval/README.zh-CN.md#集成边界)拥有字段别名与兼容规则。渲染器和 AML 记录投影位于 `src/integration`，并由 `src/index.ts` 导出。TypeScript 与薄 Python 协议渲染器消费同一份产品层 JSON 策略，安装器随客户端分发该策略。共享测试样例检验两者的可观察一致性。既有富 Agent Surface 输出保持不变。

原始话语导入保留经过校验的消息／会话时间，不取决于文本是否命中展示规则。未知历史时间保持未知，创建时间与有效期保留各自含义。渲染发生在结果选出之后，不修改存储、证据或检索输入。

## 考虑过的替代方案

- 另建来源时间存储：原始话语导入已经由 `eventTime` 表示，不需要第二套存储。
- 给持久化陈述加前缀：为纯展示决策改变 embedding、去重与证据输入。
- 维护 Python 或数据集专属检测规则：复制策略，导致产品／评测行为漂移。
- 给每条纯文本记录无条件加日期：即使问题和证据都不需要时间锚点，也增加上下文。
- 用 `createdAt` 猜测缺失历史时间：制造错误时间线。

## 后果

云端适配器可以经同一库投影原生记录，不必复制检索或时间策略。提供的 v19 云端后端通过独立源码覆盖包适配，因为该已部署应用的 owner 不在本仓库；覆盖包不代表部署。既有 NMG AML 响应仍可通过其已记录的历史时间别名消费。

该策略是有界展示启发式，不是时间推理器。契约测试与离线服务测试不能证明答案准确率、Workers 运行时行为、生产上线或新的 LoCoMo 全量成绩。本变更不导入压缩包中无关的重试、分块或评分修改，也不解释未保留响应体的历史故障。
