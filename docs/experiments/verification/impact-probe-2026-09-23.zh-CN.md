# 导入影响验证探针 — 2026-09-23

[English](impact-probe-2026-09-23.md) | [简体中文](impact-probe-2026-09-23.zh-CN.md) · [术语](impact-probe-2026-09-23.terms.yaml)

证据边界（2026-10-17 文档审阅）：下文耗时、测试计数、检查结果与工具／路由描述均属于其记录输入上的历史观察，不是对当前文档工作树的新检查。本次翻译审阅未执行套件、门禁、覆盖率运行或 benchmark；缺失的 run 身份或快照细节仍是明确的不确定性。

## 问题与协议

依赖图能否为 `src/core/simhash.ts` 的一处改动选出更小的产品测试集，同时保留对仍未验证部分的诚实交代？这是一个研究探针，不是被采纳的验证路由。

该探针清点 Git 可见的 TypeScript 文件，解析静态 import 与 export 以及字面量 `import()` 与 `require()` 调用，沿反向导入边回溯，并把可达测试与 `test:product` 的文件 glob 求交。它在候选执行前后对受检的 TypeScript 文件、`package.json`、`package-lock.json`、`tsconfig.json` 以及 Node 版本/平台/架构取哈希。它以退出码 2 报告候选，即使候选通过也是如此；退出码 1 表示候选执行或规划失败。

在 Windows 上从仓库根运行以下命令：

```text
rtk node --experimental-strip-types scripts/verification-impact-probe.ts --source src/core/simhash.ts --execute
rtk npm run test:product
rtk npm run agent:verify -- --full
rtk node --experimental-strip-types scripts/verification-impact-probe.ts --source src/core/simhash.ts
```

候选运行与随后的完整验证器使用输入摘要 `8e861d5c8728603c07ae4aa5ebc04e3519294862b244426ed897440db04a1839`。

## 观察

| 运行 | 结果 | 耗时 |
| --- | --- | ---: |
| 导入图规划 | 扫描 618 个 TypeScript 文件；175 个产品测试文件中选中 14 个候选文件 | 0.7 s |
| 候选测试执行 | 候选测试通过；探针以退出码 2（`candidate-only`）结束 | 14.3 s |
| `agent:verify --full` 中的完整 `test:product` | 1,532 个测试通过 | 85.1 s |
| 完整 `agent:verify --full` | 全部阻塞检查通过；建议性的 research 与 chaos 检查按策略跳过 | 端到端 137.3 s |

报告值为候选执行 14.3 秒、完整产品测试阶段 85.1 秒（比值约 5.95）。它们属于不同执行范围，不是受控的阶段级加速、可靠性或完整验证器收益估计。137.3／85.1 秒这一组也被原子检查报告引用；不同文档不证明独立运行。当前官方闸门还会执行其他检查，本实验没有替换它。

## 覆盖缺口与决定

该图找到了三个位于 `test:product` 之外的可达测试与四个未解析的导入，其中包括计算得到的模块路径与一个生成的模块。它不跟踪 JavaScript 模块、文件读取、生成的输入、环境依赖或行为性需求。一个夹具测试演示了一个测试读取被改动的源文件却不导入它；该图漏掉了这个测试。另有夹具检查传递式与字面量动态导入、变化的输入摘要、缺失的源文件以及非通过的 CLI 退出状态。

因此这 14 个文件是有用的快速反馈候选，但它们的通过无法为 SimHash 改动背书。该探针始终报告 `fullGateRequired: true`。在某个子集能够替代任何阻塞检查之前，其 owner 需要为该检查声明输入/依赖契约、显式处理未知依赖，并用反例测试证明当无法建立闭包时选择器会升级。对本次实验而言，完整闸门仍是权威结果。
