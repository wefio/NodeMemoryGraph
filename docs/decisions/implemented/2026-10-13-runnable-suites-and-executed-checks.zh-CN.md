# 区分可运行套件与测试输入、通过与未执行

[English](2026-10-13-runnable-suites-and-executed-checks.md) · [术语](2026-10-13-runnable-suites-and-executed-checks.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [可见的非阻塞研究轨](2026-09-12-visible-non-blocking-research-track.zh-CN.md), [归档运行认领](2026-09-19-acknowledge-archived-run-directories.zh-CN.md)

## 问题

按需 workflow 把 CI 覆盖清单中的全部未覆盖文件直接运行，混入了故意未实现的评测输入旁边的冻结检查，以及被否决候选的归档测试。直接运行 report 的 `alpha.test.ts` 会在原有 `not implemented` stub 失败，并没有测量 harness 填入候选后的行为。

Tensor 堆检查在显式 GC 不可用时使用恒真断言表示通过。HA 压力用例虽执行了 NaN 检查，却可能省略堆观察，一个通过的名称仍同时声称两个判定。结果不能区分实际检查成功与前置条件缺失。

## 决策

规范由[CI 与执行契约](../../design/ci-cd-and-quality.md#3-ci-契约)拥有。覆盖工具保留完整的 tracked 未覆盖清单，未认领的 CI 缺口仍失败关闭；同一份认领根表同时记录能否独立执行，具体的评测 fixture 根先于较宽的 harness 根。`--list` 只输出可运行项，不输出评测输入或归档证据。workflow 保留每个路径的参数边界，以 `pipefail` 保留 Node 失败状态；空清单写出 skipped TAP，不触发无文件参数的自动测试发现。

GC 前置条件由[测试运行时章节](../../design/ci-cd-and-quality.md#4-可组合测试运行时)拥有。没有 GC 时使用真正的 `node:test` skip；HA 的 NaN 压力和堆增长采用两个字面量具名用例，前者仍执行。传播循环是局部普通函数，保留原 NaN 判定、操作顺序与迭代次数，原分配量和堆阈值不变。原生子进程回归分别启用、禁用 GC，并在不继承父进程 `NODE_TEST_CONTEXT` 的情况下检查实际 TAP 状态。

## 考虑过的替代方案

- **在发现阶段隐藏 fixture 和归档文件。** 这会丢失清单与认领理由。执行过滤是另一视图，不删除证据，也不泛化豁免任何名为 `fixtures` 的路径。
- **把 fixture stub 原地改成通过。** 冻结检查用于裁定候选；为错误的运行入口实现输入，会改变评测工具本身。
- **在 workflow shell 中再维护排除列表。** 这会形成两个分类 owner。workflow 消费工具的可运行视图。
- **没有 GC 就跳过整个 HA 压力，或给所有产品 worker 开启 GC。** 前者丢失独立的数值检查，后者把局部前置条件扩张到无关测试。拆分具名判定保留各自范围。
- **引入通用 case DSL 或算子注册表。** 这两项报告修复只需普通函数、数据和断言，不构成统一其他测试写法或迁移无关消费者的理由。

## 后果

fixture 检查仍由其 harness 使用，归档保持原样。默认 CI 的覆盖义务与按需 workflow 的非阻塞地位不变。合成 Git 仓库和真实 workflow shell 正文的回归覆盖空清单、带空格路径、未认领缺口与 Node 失败；Windows 上使用 Git Bash，而非 WSL 启动器。

默认产品运行可以如实报告堆检查 skipped；显式 `--expose-gc` 执行测量原有堆增长见证。通过不证明所有分配方式均无泄漏。Windows 本地验证不声称已运行 GitHub workflow 或 Linux，也不需要真实 provider 或完整 benchmark。

## Follow-up

原始 Windows 十套件运行在 `e5b19733` 上共 91 项，86 通过、5 失败；五个恢复消费者读取了已移除的 `ticket.patch.digest`。本报告修复保留其选择和失败记录。[独立恢复修复](2026-10-13-recovery-tests-use-frozen-declarations.zh-CN.md)纠正消费者漂移并补上类型检查入口缺口，由该记录拥有后续结果及证明边界。产品门禁通过本身仍不能建立按需套件已经执行的结论。
