# NMG 文档

[English](README.md) · [使用的术语](README.terms.yaml)

用本索引选择阅读入口，或找到文档修改的 owner。先按任务定位；解释冲突时，再用下方权威顺序判断应修改哪一处。

## 所有权与权威顺序

1. **[design/design.md](design/design.md)** 是系统的规范模型。行为或架构发生变化时，负责该内容的设计文档必须与实现一致。
2. `design/` 下的专题设计文档负责深入说明单个机制；它们细化基线，但不能静默替代基线。机制文档描述阶段、约束归属、不变量和状态签名——不含数值、不含日期、不含论证。调参不应该改动它；若必须改动，说明哪个不变量被打破了。
3. **`decisions/`** 记录非平凡选择的原因、考虑过的替代方案和后果。决策文档解释设计，但不是第二份规范。
4. **[design/completion-audit.md](design/completion-audit.md)** 是需求到证据的当前台账，只记录实现与验证状态，不定义设计意图。
   **[design/implementation-lineage.md](design/implementation-lineage.md)** 是精选的 commit-to-owner 恢复索引；Git 仍是完整 changelog。
5. **[design/temporary-todo.md](design/temporary-todo.md)** 只保留未完成事项。完成历史留在 Git；有长期价值的结果应写回对应的设计、决策、操作或审计文档。
6. **`experiments/`** 保存 benchmark、审计、探针和回归等观测结果。实验可以推动决策，但不能仅因测得结果就成为规范。
7. **`postmortem/`** 保存事故记录：一次逃逸出去的失败、它背后的机制、每一道安全网为什么没拦住，以及现在能拦住这一类的防护。它的触发条件、必需章节、提升与分类规则以及索引见 [postmortem/README.zh-CN.md](postmortem/README.zh-CN.md)。
8. **`skills/`** 保存 Agent 工作流。Skill 说明如何维护或使用项目，并链接规范来源，不复制项目事实。
9. **`guides/`** 保存非规范的学习路径与导航图。Guide 运行公共契约并把读者路由到 owner，不重新定义设计。

文档冲突时，应修正拥有该信息的文档，而不是新增一份摘要。Git 继续承担实现历史。若某项细节有意只保留在 Git 中、但以后很难重新定位，应在相关审计或决策文档中留下 commit 或 decision 链接，而不是复制整段实现流水账。

## 目录说明

| 读者任务       | 从哪里开始                                                               | 能回答什么                                             |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| 第一次使用记忆 | [第一次回忆教程](guides/first-recall.zh-CN.md)                           | 从写入到回忆的可运行路径                               |
| 理解产品概念   | [概念地图](guides/concept-map.zh-CN.md)                                  | 局部解释与行为合同入口                                 |
| 查仓库流程术语 | [术语查询](design/documentation-governance.zh-CN.md#yaml-文件与查询合同) | 规范词形、别名、作用域和 owner；局部未命中不等于不存在 |
| 修改行为或架构 | [系统模型](design/design.md)及对应专题                                   | 包含条件和例外的权威合同                               |
| 核对实现证据   | [完成审计](design/completion-audit.md)                                   | 实现与验证情况，以及证据边界                           |
| 编写或整理文档 | [维护流程](#维护流程)                                                    | 修改位置、应保留的内容和验证方法                       |

以下目录入口定位专门材料，不是必须顺序通读的清单。

- **产品入门：**先用[概念地图](guides/concept-map.zh-CN.md)理解术语和 owner，再运行[第一次回忆教程](guides/first-recall.zh-CN.md)。
- **`guides/`**：非规范导航与经过测试的演练。
- **`design/`**：架构、数据模型、算法和流程契约；被取代的设计移入 `design/archived/`。[实现沿革索引](design/implementation-lineage.md)只记录能显著降低重新定位或重复犯错成本的 commit。
- **`decisions/`**：带生命周期的设计与流程决策，见 [decisions/README.zh-CN.md](decisions/README.zh-CN.md)。
- **`experiments/`**：测量证据，按每次运行回答的探究线分组（见[主题清单](experiments/README.zh-CN.md)）。相关入口包括
  [节点摘要加速检索调研](experiments/retrieval/node-summary-accelerated-retrieval-2026-08-19.md)
  和保留的[历史 benchmark 快照](experiments/benchmark-results.zh-CN.md)。
- **`postmortem/`**：按编号排列的事故记录，附失败类别索引；写之前先读[它的索引](postmortem/README.zh-CN.md)。

简化判断：NMG _怎样工作或应该怎样工作_ 写入 `design/`；_为什么这样选择_ 写入 `decisions/`；_实际测到了什么_ 写入 `experiments/`；_什么坏了、为什么逃过_ 写入 `postmortem/`。实验 commit 只有被明确的设计或决策 owner 接纳后，才会成为规范。

## 双语规则

所有非临时、面向读者的文档都必须提供英文和中文版本，包括长期保留的设计、决策、实验报告、事故记录、操作指南、Skill 及其 reference。内部目录、draft 或归档身份不是豁免。长期维护的 TODO 索引不因文件名包含 `temporary` 就成为可丢弃材料。

每个文档主题使用同一主题名，组成相互关联的三件套：

- `topic.md`：英文正文；
- `topic.zh-CN.md`：中文正文；
- `topic.terms.yaml`：两版正文使用的术语，包含本主题拥有的定义及对其他定义的规范词形引用。

中英文版本互相链接，并链接共用的术语文件。两版保留相同事实、义务、条件、警告与命令，不要求逐段一致。术语引用不形成第二份定义。正确的 API、路径、值和命令等字面量不因翻译改变；只有实际合同变化，或经核实的错误示例修正，才修改它们。

只有明确可丢弃、带清理条件的临时工作材料可以保持单语；一旦作为文档保留，就应补齐三件套。原始数据、日志、源码和机器输入 fixture 不是待翻译的正文，保留原始字节，并在文档中单独说明。

存量缺译或缺少术语伴随文件属于待整改项，不构成隐含豁免。写定规则不等于覆盖完成。下方 CI 表仍只陈述已准入的机械检查与严重级别；检查通过不证明双语和术语已全量覆盖。

## 维护流程

[文档治理设计](design/documentation-governance.md)说明读者审稿、分布式 YAML 定义及各项检查的边界，不替代以下维护流程和 CI 政策。

行为、架构、评估证据、公开说明或文档布局发生变化时，使用 [`doc-maintenance` Skill](../skills/doc-maintenance/SKILL.md)。提交文档修改前运行 `npm run docs:check`，一次执行结构校验与文档组三件套完整性检查。译文含义与漂移仍由审阅判断；已准入语料的三件套缺件属于错误。CI 阻止公共/规范入口破损、错误决策结构，以及活跃设计和 Skill Markdown 的结构卫生错误。其他检查各自的错误／告警范围见下表；通过检查不证明文笔合格或语义等价。

## CI 契约

本节是自动文档检查的规则所有者。修改 `scripts/verify-docs.mts` 或 `scripts/verify-document-groups.ts` 前先修改本表；脚本只负责实现这些规则，不得自行增加政策。

| 规则                                                                                        | 范围                                                                                                                                                                                                                                                 | CI 结果    |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| ATX 标题和章节非空，同一父节内的同级标题规范化后不重复；排除围栏代码与 HTML 注释            | 全部活跃 `docs/design/**/*.md`（排除 `docs/design/archived/`）和全部 `skills/**/*.md`；必需文档 `docs/design/documentation-governance.md`、`docs/design/ooo-execution-bootstrap.md`、`skills/doc-maintenance/references/reader-review.md` 仍不得缺失 | 错误       |
| 中英文入口文件同时存在                                                                      | 根 README、docs 索引、决策索引、事故复盘索引                                                                                                                                                                                                         | 错误       |
| H1 与本地链接有效                                                                           | 根 README、docs 索引、规范设计基线、完成审计、决策索引与记录、事故复盘索引与记录、每个 Skill 入口                                                                                                                                                    | 错误       |
| 文件名、唯一生命周期位置、精确状态和非空必需章节符合决策契约                                | 决策记录                                                                                                                                                                                                                                             | 错误       |
| 文件名、唯一连续编号、精确状态、非空必需章节，以及每篇记录恰有一行索引                      | 事故复盘记录及其索引                                                                                                                                                                                                                                 | 错误       |
| Skill frontmatter 包含与目录同名的 name 和非空 description                                  | 每个 `skills/<name>/SKILL.md`                                                                                                                                                                                                                        | 错误       |
| H1 与本地链接有效                                                                           | 其他文档及 Skill reference                                                                                                                                                                                                                           | 警告       |
| 内容文档位于 `design/`、`decisions/`、`experiments/` 或 `postmortem/`                       | `docs/` 下除 README 与 AGENTS 外的直接子文件                                                                                                                                                                                                         | 警告       |
| 英文、中文与术语配套均为普通文件；孤立配套也报错                                            | 根 README，以及 `docs/`、`skills/` 下全部 Markdown／术语配套，包含归档与新增子主题                                                                                                                                                                   | 错误       |
| 成对文档互相链接且标题结构大致一致                                                          | 双语文档对                                                                                                                                                                                                                                           | 警告       |
| 实验运行报告文件名以 `-YYYY-MM-DD.md` 结尾；滚动汇总和笔记使用 `-results.md` 或 `-notes.md` | `experiments/` 下的文档                                                                                                                                                                                                                              | 警告       |
| 显式决策替代元数据使用有效的本地双向链接                                                    | 声明替代关系的决策记录                                                                                                                                                                                                                               | 警告       |
| 常驻规则入口遵守既有 UTF-8 字节预算：Skill 入口 15,000 B，AGENTS 与决策索引 5,000 B         | AGENTS.md、全部 `skills/*/SKILL.md` 入口、决策索引                                                                                                                                                                                                   | 错误       |
| 活跃设计阅读单元不超 15,000 UTF-8 字节，新增子主题继承同一上限                              | `docs/design/` 下全部 Markdown，排除 `docs/design/archived/`                                                                                                                                                                                         | 错误       |
| 翻译质量、设计正确性、实验结论、文风，以及某个失败类别是否已被提升为规则                    | 所有文档                                                                                                                                                                                                                                             | 不自动判断 |

分组从英文、中文与术语文件的并集发现，不依赖迁移清单；同时删除两版正文也不能隐藏残留术语文件。不遍历符号链接目录，符号链接配套也不算普通文件。唯一可丢弃例外是[运行草稿](experiments/execution/archive/ooo-arms-2026-09-19/speculation-earm/run2-2026-09-19T05-40-04-311Z/CLEANABLE-scratch-2026-09-19.md)，且仅在没有配套文件并保留所述清理条件时生效；新建 `CLEANABLE` 文件名不能获得豁免。准入语料之外的面向读者文件仍遵循双语规则，本检查不证明其覆盖完成，也不验证翻译含义、YAML 语义或确认新鲜度。现有链接和术语检查保留各自范围。

错误表示仓库公开或规范接口发生了可机械复现的破损；警告只作为 Agent 或 reviewer 的维护输入，不得导致 CI 失败。

设计文档按完整职责路由到具名子主题，不抬上限，也不把过长正文挪入不受检查的设计子目录。必要条件、例外和依赖保持完整，迁移后重定向相对链接并核对入口锚点。归档设计和实验原始证据保留各自角色，不套活跃设计上限。

Skill 字节预算锁的是其常读入口，而不是 Skill 下的每个文件。入口接近上限时，把偶发才需要的节路由进
`skills/<name>/references/`，并在入口里写明每节的触发条件（[决策](decisions/implemented/2026-09-18-skill-grows-by-routing.md)），
而不是抬上限、也不是把一条规则压到丢掉它依赖的事实。
