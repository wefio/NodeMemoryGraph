# 重平衡无法消耗的维护压力

[English](0005-maintenance-pressure-cannot-drain.md) · [术语](0005-maintenance-pressure-cannot-drain.terms.yaml)

**Status:** resolved

## Executive summary

常驻 daemon 用包含已替代记录的访问余额选取维护节点，但层级重平衡只消耗 indexed 且 active/disputed 记录的余额。满批次因此不断触发下一批，触发条件却未被清除。旧测试只覆盖有效记录的正常积压，没有覆盖资格变化。修复让压力统计与可消耗工作一致，并通过 store 和服务接口验证停止条件。

## Summary

词法接入期间的只读检查发现，占用热点是维护流水而非检索追踪。最近 1000 条流水反复处理同四个节点：889 条 local、111 条 semantic。local 没有改变记忆层级或重建叶块，semantic 报告零变更行；这些现象本身不能证明每次 SQL 操作都无变更。

## Impact

2026-10-11 14:13 UTC 的快照中，`maintenance_runs` 有 6,726,892 行，其表与两个索引占 3,107,803,136 字节，约为数据库页面总量 3,272,433,664 字节的 95%；检索追踪占 10,465,280 字节。这是一个本地数据库的观察，不是一般体积或延迟保证。重复调度增加了重平衡与流水写入，没有证据表明发生记忆丢失或短引用误绑定。修复不删除历史，也不回收已有文件空间。

## Timeline

- 已部署服务的压力统计与消耗条件不一致。
- 词法／引用接入先通过了既有针对测试和 clean 检查。
- 只读检查定位重复批次与历史访问余额。
- 临时库测试要求有效压力未达阈值时不维护，首红为 `1 !== 0`。
- 修复后，资格、空流水与常驻服务回归通过；没有执行历史裁剪。

## Root cause

全局和节点访问求和包含 `rebalanceNode` 排除的记录，每次维护后其余额仍在。当足够多此类节点填满 `nodeLimit`，服务的满批次续调度持续执行，semantic 也随 productive local 批次频率运行。维持循环不需要新用户访问。dormant 记录存在同类条件不一致。

旧积压测试只使用 active/indexed 记录并断言工作推进；直接 due-node 测试只检查返回数组；服务测试没有经过资格转换。类型、schema、打包和静态门禁不能判定运行时触发条件可被消耗且最终停止。

## Guardrails added

- [Store 维护回归](../../tests/core/store/maintenance.test.ts)：已替代／休眠压力、有效记录正对照、停止条件、重新激活，以及空检查保留性能聚合。
- [服务回归](../../tests/cli/service.test.ts)：通过 RPC 与 event-loop 切片处理真实文件库积压，保留历史记忆。
- [维护契约](../design/design.md)：拥有资格和流水语义。不能仅因 `rowsTouched` 为零抑制 semantic 流水，因为排空 trace 信号也会改变持久状态。

## Lessons

触发条件必须对应 worker 能消耗的状态。单批有界，不代表触发条件始终存在的循环有界。用资格转换与停止测试拦住同类错误，而不是添加提醒；按意义保留来源链，不因体积大就合并流水。
