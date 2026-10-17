# 信息项驱动的共享上下文

[English](2026-10-13-context-information-views.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [共享信息输出](2026-10-07-shared-information-output.zh-CN.md)

## Problem

动态消息混合按来源分类的召回/AG、工作状态、行动提示和运行诊断。大字符串难以独立
选取；历史黑板读取和旧工具错误会持续被呈现成当前材料。

## Decision

[状态空间 owner](../../design/state-spaces.md#统一上下文信息项)定义现有及新增 state 内容与
动态消息共享的 InformationView 协议。类型化条目是基本单位，职责分组不是新来源 owner，
不建立状态表、视图图谱、Task 抽象或编排语言。

共享准备整项选取，把分组外壳计入一个上下文预算；普通平铺输出保持兼容。自动准备不将
被遗漏的记忆预记为披露，也不推断 provider 可见性。AG/黑板仍拥有原生命周期与权限；
显式历史读取继续可用，但不自动变成工作上下文。

Pi 保留自动召回共享时限与取消路径，类型化 AG 读取、可选 checkpoint 与 telemetry 均在
同一预算内。超时后仍通过同一准入协议呈现已完成的类型化信息项，不恢复原始 header 回退，
也不写入披露历史。归因只采用最终输出实际准入的记忆 ID。

## Alternatives considered

- 保留五块大字符串：不能独立遗漏信息项，也混淆职责。
- 新增 StateView 或 adapter 私有选取器：重复现有来源绑定协议。
- 用 Markdown 表或视图图谱做协议：把呈现形式变成数据或第二 owner。
- 根据正文猜任务相关性、猜错误已恢复：把语义判断混入确定性生命周期。

## Consequences

来源与用途分离。候选预览、暂存声明和引用的 graph 作用域随信息项保留；工作状态完整。
有界压缩恢复先于可选材料；遗漏说明不挤掉状态、恢复或诊断。RPC 保留结构化的工具结果/
错误来源，不根据正文猜测。
短期观察由原 owner 提供回合戳，无此元数据的旧观察保持可显式读取，不自动升级为当前材料。
呈现不改变 delivery、写入 fencing 或协作裁定。

## Deferred

语义任务身份、独立 Task owner、管理表界面、图可视化、最终 provider 发送确认和模型/cache
收益均未证明。共享 daemon 部署需另行协调 reload；源码验证不等于部署。
