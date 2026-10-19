# Contract 声明面与 IR

[English](contract-surface-and-ir.md) · [使用的术语](contract-surface-and-ir.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.zh-CN.md)。

## Contract 声明面与 IR

编写 Contract，或解释编译与断言证据报告时，使用本参考。Contract 声明目标、作用域与约束，
不编排逐条 shell 操作；具体动作由可替换的 planner 或 provider 选择。

声明使用 YAML 或 JSON，编译为稳定、Agent-neutral 的 Contract IR。设计借用 CUE 的约束语义
与 OPA 的纯策略边界，不引入两者的完整运行时或产品范围。

### 编写有界声明

以下示例说明 schema。请将 intent、scope 与断言替换为实际变更；其中
`node-test:daemon-cli` 绑定不表示该路由能独立证明整个 daemon/Core 的依赖边界。

```yaml
apiVersion: repository.nmg.dev/v1alpha1
kind: AgentChange
metadata:
  id: rcp-001 # 被引用后保持稳定
spec:
  intent: "what should be true"
  scope:
    include: ["src/**"]
    exclude: ["docs/experiments/**"]
  preserve: ["public protocol compatibility"]
  assertions:
    - id: daemon-independent
      statement: "NMG daemon must not depend on RCP"
      domain: "NMG daemon and Core imports in this repository revision"
      assumes: []
      strength: witness
      check: "node-test:daemon-cli"
      kind: test
      stage: unit
  verification:
    routes: ["product"]
    checks: ["npm run agent:verify"]
  authority:
    mode: plan # plan | apply | continuous
  extensions: {}
```

每条断言必须提供 `domain` 与 `assumes`；没有适用的登记假设时使用 `[]`。
证据必须在 `check` 与 `documentedOnly: true` 中二选一，不能同时声明。
缺少两种证据声明或缺少必需的 claim 字段时，编译失败。编译成功只证明 schema 一致，
不证明断言为真，也不证明它选取的范围或检查足够。

检查解析到 package script、表示路由级证据的 `node-test:<route>`，或指向具名测试的
`node-test:<route>#<测试名>`。`rtm:check` 核实该名字存在于此 route 的测试文件中。
如何选择域、假设与证据强度，见[验证追溯流程](../../../../skills/verification-traceability/SKILL.md)。

### 阅读断言证据，而不是只看清单

`rtm:check` 在 `verify:static`、narrow 共享检查与两份 authored contract 中阻塞执行，
按[证据聚合决策](../../../decisions/implemented/2026-09-20-rtm-evidence-aggregation.md)
输出报告。断言数、可解析检查数、仅文档项、未覆盖项和孤儿检查数只是清单，不参与成立判定。

每条断言根据 `agent:verify` 写入 `.nmg/verification/latest.json` 的执行证据分别取得状态：

| 状态 | 记录实际说明什么 |
| --- | --- |
| `executed` | 承载命令在当前版本通过。 |
| `historical` | 在其他版本通过，不算当前执行。 |
| `not-run` | 本轮记录为跳过或失败，并带原因；只有属于当前轮次的失败让 gate 失败。 |
| `not-recorded` | 缺少记录、承载命令或证据文件。 |
| `documented-only` | 声明没有可执行的证据绑定。 |
| `uncovered` | 声明缺少覆盖。 |

风险类别（strength、kind、stage）与跨多个 route 的契约各自判定；未决项进入反例。
报告明确没有总判定。收据抓取打印出的报告；检查的 `evidence` 输出只在该检查失败时附加。

### schema 演进时保留身份

IR 规范化默认值、路径、source locations、diagnostics 和 extension namespace，
并计算 `contractDigest`。语法升级不得改变已被引用的 `metadata.id`。
未知必需字段失败关闭；未知可选 extension 数据可以保留，但不能静默执行。
