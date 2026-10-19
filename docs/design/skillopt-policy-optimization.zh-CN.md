# SkillOpt 策略优化边界

[English](skillopt-policy-optimization.md) · [术语](skillopt-policy-optimization.terms.yaml)

NMG 把微软 SkillOpt 集成为**离线 Lab 策略优化器**。它不是记忆编辑器，也不属于普通 Pi 推理的一部分。

## 可训练与不可变的状态

已实现的适配器训练的是一个**仅控制器决策策略**。它从 `src/prompts/nmg-prompts.yaml:memory_policy` 初始化，但其评估器要求一个严格的机器可读 `recall_action`/`fold_noise` 决策。该工件与作答 Agent 所见的全局自然语言策略不可互换。第一次匹配的晋升运行通过抓到控制器 JSON 泄漏进用户答案，证明了这条边界。

SkillOpt 可以提出有界编辑，涉及：

- 是回答、展开召回，还是停下；
- 检索到的噪声是否应被折叠；
- 何时需要精确证据；
- 何时「没有有用的记忆」是一个有效结果；
- 历史记忆与实时的代码／文件／网络来源有何不同。

它绝不能作为 prompt 文本编辑或学习：

- 原始历史或来源证据；
- 用户事实、偏好、约束或当前状态；
- STG、LTG 或 Active Graph 的内容；
- 节点身份、边身份或已存记忆陈述。

那些对象是运行时数据，其归因保留在来源上。benchmark 答案或验证标签不得成为持久的用户记忆。

## 两阶段门禁

离线适配器有意只评估一个小而稳定的决策面：

```text
observable retrieval state + candidate policy
    -> recall_action: answer | expand | stop
    -> fold_noise: true | false
```

只导出显式反馈标签。沉默、正常完成、没有纠正、候选暴露与 benchmark 金标答案都不会被转换为自然使用标签。整个语义任务按时间顺序划分为训练、验证与未触碰的测试集合，使重试无法跨越划分。

通过 SkillOpt 的留出门禁产出的是一个**候选**，不是生产策略。晋升还要求一次匹配的 Pi + NMG 运行：模型、历史、问题、检索配置与评分器保持不变，只换策略。它必须报告：

- 答案质量与任务成功；
- 精确证据召回与冲突证据召回；
- 错误／过时记忆的使用与污染；
- 不必要的检索与展开；
- 注入的 token、工具调用与端到端延迟。

Agent 与控制器现在各有独立的策略通道。作答 Agent 始终收到经审阅的 YAML；Lab 候选只能填充控制器通道，不能改动系统提示。经审阅的 YAML 编辑仍是 Agent 策略唯一的生产采纳路径，而且 NMG 在生产中不加载 `best_skill.md`。当前文本候选由隔离的 SkillOpt 适配器评估；在它的决策经带类型的控制器边界投影并通过匹配门禁之前，它不是运行时执行器。

## 数据就绪度

正式就绪度只接受普通 Pi 使用且
`collectionOrigin=natural` 的反馈。有界的无头 `pi-control` 辅助程序总是把自己的运行标为 `controlled`；没有来源的遗留事件是 `unknown`，会被排除。受控行与遗留行可以练解析与适配器管线，但不能满足训练或晋升阈值。

导出器默认采用保守的工程下限，不是统计功效保证：

- 共 24 个独立语义任务；
- 12 个训练任务；
- 6 个留出验证任务；
- 6 个未触碰测试任务。
- 至少两个观察到的召回动作与两种噪声标签取值。

低于这些计数时，正式导出 fail closed。`--allow-insufficient` 只用于检查适配器与文件布局；它的输出不能授权训练或晋升。

当前每一条导出行都要求一次检索加一次自然反馈，并带稳定的 `semanticTaskId` 与全部四个检索标签（`evidenceSufficient`、
`expansionUseful`、`excessiveNoise` 与 `noMemoryNeeded`）。`use` 与 `outcome`
事件会丰富一行，但在当前的召回策略导出器里不是必需。未来的维护策略数据集可能额外要求长时程结果；那是一个独立、尚未实现就绪度契约。

扩展与导出器此前默认使用不同的 shadow 路径。这个问题在 2026-08-11 由一个共享解析器修正：普通使用默认 `~/.nmg`，而受控辅助程序显式选择项目本地的 `.nmg`。来自任一文件的历史计数都是快照，在做出就绪度断言之前必须重新导出。2026-08-20 的正式导出已就绪，24 个独立任务：12 个训练、6 个按时间顺序的验证、6 个未触碰测试，且两类必需动作与两种噪声标签取值齐备。

## 首次官方优化与晋升结果

第一次官方 SkillOpt 运行通过 OpenAI 兼容端点使用 DeepSeek V4 Flash，seed 42，三个 epoch，batch size 8，四个 rollout 与分析 worker，以及 4096 token 的目标完成预算。在固定划分上：

- 验证硬准确率从 1/6 提升到 4/6（第 9 步）；
- 未触碰测试硬准确率从 1/6 提升到 2/6（软准确率 3/6）；
- 本次运行进行了 258 次模型调用，使用 1,254,494 个 token（775,127 prompt 与 479,367 completion token）。

离线收益没有通过匹配 Agent 门禁。在相同 Pi 模型与六个集成 case 下，规范策略通过 6/6，而候选 SHA-256 为
`8133cc870189c451dac4548fe68d49388d7fb4353b17b1ad89cfbeb16f5618b1`
的候选通过 4/6。该候选把两个用户答案替换成了控制器 JSON，并给其他答案加上了同一内部协议前缀。它被拒绝，规范 YAML 保持不变。这个结果验证了两阶段门禁，也否证了「经控制器优化的文本可以原样安装为 Agent 的全局记忆策略」这一假设。

## 提议的维护策略扩展

**Status: 审阅通道已实现；优化器推迟。** 一个
`memory_maintenance_policy` 候选可以使用同一套离线优化与两阶段晋升协议，提出内容重写、作用域纠正、取代、拆分或合并。核心持久化保存哈希绑定的策略身份、长时程分数、留出或匹配重放的参照、证据与审阅状态。它区分内容、作用域与检索缺陷；检索缺陷只被接受为 `observe` 提议，不能变更记忆。审阅通过同样不会执行任何变更。

自动提议抽取与 SkillOpt 训练保持推迟，直到自然标签足够为止。既有显式反馈、采集 provenance 与带日志的变换支撑那个未来优化器，但不授权它。规范性边界记录在 `design.md` 的「Offline text-space policy optimization」一节；操作命令在可选能力手册里。

## 命令

官方 SkillOpt 检出保存在被忽略的 benchmark 目录下：

```powershell
git clone --depth 1 https://github.com/microsoft/SkillOpt.git `.benchmarks/official/SkillOpt`
npm run eval:skillopt:install
```

导出当前的自然使用观察：

```powershell
# Formal path: exits with code 2 while the readiness gate is not met.
npm run eval:skillopt:export

# Engineering smoke only.
npm run eval:skillopt:export -- --allow-insufficient
```

导出把 `train/val/test/items.json`、`initial_skill.md`，以及一份带来源／策略哈希与不可变边界的清单写到
`.benchmarks/skillopt/nmg-policy` 下。

数据集就绪之后，按其上游文档安装 SkillOpt 的 Python 环境，并运行它打过补丁的 `configs/nmg_policy.yaml`。适配器使用 SkillOpt 配置的 target/optimizer 后端，且从不打开 NMG 的 SQLite 数据库。在 Windows 上，给官方 Python 进程设置 `PYTHONUTF8=1`，以免 UTF-8 JSON 通过遗留系统代码页被解码。把选定的 provider 凭据装进进程环境；不要把它们存进 SkillOpt 输出或已提交配置。

答案路径隔离回归可以在不改动规范 YAML 的情况下，对 NMG 既有的 Pi case 跑：

```powershell
$env:NMG_SKILLOPT_POLICY_PATH = "C:\path\to\best_skill.md"
npm run eval:agents
Remove-Item Env:NMG_SKILLOPT_POLICY_PATH
```

runner 会把候选编码进一个显式标记为 Lab-only 的控制器通道，并只在报告里记录其 SHA-256。报告还会说明候选未被应用到作答 Agent。这次运行证明的是没有 prompt 泄漏；它不测量候选控制器的质量。隔离的 SkillOpt 适配器测量那个决策面。Pi 扩展会拒绝缺失、过小、过大或注入运行时标签的候选，而普通 Pi 进程忽略候选机制。

## 这个实验能证明什么、不能证明什么

它可以检验一份写得更好的稳定策略是否能改进在相同可观察检索状态下做出的决策。它不能优化 embedding、图拓扑、节点合并、证据排序或数据库行为。那些是各自独立的 NMG 机制，需要各自的匹配消融。
