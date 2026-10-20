# 恢复测试使用冻结声明

[English](2026-10-13-recovery-tests-use-frozen-declarations.md) · [术语](2026-10-13-recovery-tests-use-frozen-declarations.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [不透明派发声明](2026-09-21-mechanism-not-policy.zh-CN.md), [可执行套件与实际检查](2026-10-13-runnable-suites-and-executed-checks.zh-CN.md)

## 问题

基线 `66238c2` 的九项恢复场景中，五项在七处产物构造读取已移除的 `ticket.patch` 时提前失败。当前 `BoardAdmission.claim()` 返回 `BoardTicket<FrozenPatchWork>`，冻结工作位于 `declaration`；调试器在重开协调器后仍能观察到该声明，其摘要与 `inputDigest` 一致。直接 TypeScript 检查能拒绝这七处过时访问，但原阻塞 `check:tests` 未包含这些独立 harness。

## 决策

本地产物 fixture 接收 `Readonly<BoardTicket>`，要求冻结声明存在、核对声明摘要与领取输入身份，再用 `declaration.digest` 构造原有补丁信封。不重建冻结工作，不提供缺失声明的默认值。提交 fixture 使用同一票据类型；产品票据、schema、尝试代数和接受规则不变。

保留原九个字面名称及原有观察。在后继协调器场景中，先提交故意错误的产物摘要，观察宿主拒收且没有接受结果，再以同一活认领提交正确产物。这条负输入进入真实宿主，不只是 fixture 自身断言失败。

已有阻塞 `check:tests` 纳入 `evals/ooo-execution/*.test.ts`。`tests/tools/test-groups.test.ts` 用 TypeScript 实际配置解析出的入口集合，对照覆盖工具选出的可执行 OoO 套件；冻结 fixture 和归档证据不作为独立编译入口。被导入的依赖仍接受正常类型检查。运行保持按需；静态 CI 不因此执行真实 provider 或 benchmark。

合同由[测试执行轨](../../design/ci-cd-and-quality.md#2-执行轨道)和[恢复观察](../../design/ooo-execution-bootstrap.md#由此得到的改进清单)拥有。

## 考虑过的替代方案

- **恢复产品票据的 `patch` 别名。** 只为过时消费者给不透明声明合同增加第二个载体。
- **只使用 `inputDigest`。** 可以绕过补丁采用者必需声明的观察；本 fixture 明确核对二者。
- **跳过失败场景或放宽 stale／duplicate 判定。** 删除恢复义务，不是修复其输入。
- **类型检查整个 `evals/`。** 将无关仪器和冻结输入一起扩大；本次只补独立 OoO 测试入口。
- **另建 runner 或算子注册表。** 当前产物 fixture、覆盖选择和编译器门禁已经足够，不引入 DSL。

## 后果

Windows 原始复现从四项通过／五项失败变为九项通过；十套件集合从 86 通过／5 失败变为 91 通过、没有 skip。类型入口回归在原配置上失败，增加 include 后通过。十个 harness 的 strict 与 unused 检查由已有阻塞入口执行。

这些证据只支持本地协议与持久化观察，不宣称分布式 exactly-once。恢复以关闭／重开协调器模拟；schema 场景对当前构造器已建成的数据库重新执行设置，不构造旧库，也不注入操作系统级强杀。没有建立 Linux、GitHub workflow dispatch、真实 provider 或完整 benchmark 的运行结论。
