# 字段归属与不透明派发接口

[English](field-ownership-2026-10-01.md) | [简体中文](field-ownership-2026-10-01.zh-CN.md) · [术语](field-ownership-2026-10-01.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是带日期的研究或 fixture 记录。表名、源码位置、状态表述、测试计数和未完成标签属于当时快照，不证明当前 daemon `taskRun` 集成。本轮未重跑所列套件或 mutation，也未确认当前检出可用全部历史／本地重放命令。产品边界由当前 [task-unit 契约](../../design/task-unit-semantics.zh-CN.md)负责。

2026-10-01 测量，Windows / Node v24.19.0。这是受控证据，既不是实际负载，也不是对 frame／storage 提案的批准。

## 方法

[必需的机器可读记录](field-ownership-2026-10-01.json)保留 `controlledModels: 5`、base revision `256bcc0e66ebe8a946e300b8d465731caea02bf4` 与三个语义源文件的 SHA-256；它没有列出五个单独的模型身份。模型构造、完整输入与断言由[探针](../../../evals/ooo-execution/field-ownership.ts)拥有。在仓库根目录执行：

```sh
node --experimental-strip-types evals/ooo-execution/field-ownership.ts --out .temp/field-ownership-replay.json
```

已存储的观测被保留；replay 写入单独的输出。该 field-ownership 探针中没有模型调用、embedding、数据库写入，也没有使用官方 benchmark 数据。这不适用于下文单独的真实 store fixture，后者会执行 store 写入。

## 字段观测

- **Effect class 不是写入集合。** 两个 `isolated-artifact` unit 提出相同的 `data/shared.txt` 路径，并且都在两个 slot 上合法。把 B 的 class 改为 `local-write` 后，只有 A 合法，B 得到 `effect-not-startable`。这里观察到的是 class 标签的 gate，不是资源集合互斥。它们是被提出的 artifact，不是对共享文件的并发写入；这也不证明任意副作用都是安全的。
- **输入字节与资格是两件事。** 改变 A 的冻结文件内容会改变其声明 digest，但在相同的声明 revision 与依赖事实下，合法集合不变。freezer 绑定内容；该资格计算不检查字节。它既不授权修改活跃声明，也不确立一种普遍的输入表示。
- **声明的依赖边使下游解锁取决于前驱验收。** B 依赖 A 时，A 在 acceptance 之前即可 offer，B 则要等 A 的 digest 绑定 acceptance 事实之后。该事实是纯模型的受控输入，不是某个 worker 的自我报告。
- **Operation 解释结果。** 在一个输入为 `4` 的只读 unit 下，`double` 与 `sum` 具有相同的合法集合，但答案分别是 `8` 与 `0`。这展示了默认 snapshot interpreter 的选择；它不选择存储位置，也不证明未来每个 protocol 都有 operation 字段。

## 数值 adopter

[端口 fixture](../../../tests/integration/ooo-work-shape.test.ts) 声明 `{ digest, values: [2, 3] }`，而不是 patch 工作。它的执行与具名拒绝用例在 patch-only 循环下失败，随后通过不透明声明端口成功。carrier 是必需的：没有 declaration 字段的 ticket 不能静默满足 TypeScript 端口。不支持的 shape 会在取得 lease 或调用 worker 之前就返回其名称，并被记录为一次 slot 拒绝。

[真实 store 的 fixture](../../../tests/integration/ooo-value-store-board.test.ts) 在不修改 store 协调实现的前提下加入一个数值 adopter。它取得真实 lease、交付 artifact、记录来自 `numeric-judge` 而非 `numeric-worker` 的外部 verdict，并释放被接受的结果。声明体未被改动。声明校验与数值 acceptance 在 adopter 中；store 不解释这些数字。两个 fixture 都在没有 provider 的情况下运行。它们的四个用例全部通过。

这是一个小型程序化 adopter，不是已安装的产品对等 protocol。真实 store 的 fixture 用既有的 `content` 传输其受控声明体。它既不增加所提议的 `payload` 列，也不验证提案的 content／payload 分离、投影接口、protocol 选择器、未知 protocol 隔离或威胁模型。那些是另外的测试与工作。

## 仍未决定的部分

这些测量支持[归属决策](../../decisions/implemented/2026-09-21-mechanism-not-policy.zh-CN.md)，但没有把词汇上的收紧变成「无策略机制」的证明。在所测 revision 上，permission closure 读取 patch metadata，session 模块把 patch 策略与生命周期混在一起。该归属决策记录的是当前边界；上面的历史源码哈希不是对后来代码的断言。store 中针对 patch 的声明存储仍是另一个问题。

存储需要一项单独的决策：机制记录把 shape 字段分配给声明 payload，而 [frame 提案](../../decisions/proposed/2026-09-21-the-frame-and-its-storage.zh-CN.md) 保留类型化的 Task-Unit 表，并要求 Task-Unit 条目的 board payload 保持 NULL。这些观测并不选择是保留 protocol 自有的类型化声明，还是迁移为不透明任务文档。不要为了让接口看起来完整，就把任务再复制一份进 board payload。
