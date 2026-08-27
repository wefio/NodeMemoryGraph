# NMG 文档

[English](README.md)

本目录是 NMG 的长期文档界面。不同文档承担不同职责，不应作为互相竞争的多份真相来源。

## 所有权与权威顺序

1. **[design/design.md](design/design.md)** 是系统的规范模型。行为或架构发生变化时，负责该内容的设计文档必须与实现一致。
2. `design/` 下的专题设计文档负责深入说明单个机制；它们细化基线，但不能静默替代基线。
3. **`decisions/`** 记录非平凡选择的原因、考虑过的替代方案和后果。决策文档解释设计，但不是第二份规范。
4. **[design/completion-audit.md](design/completion-audit.md)** 是需求到证据的当前台账，只记录实现与验证状态，不定义设计意图。
   **[design/implementation-lineage.md](design/implementation-lineage.md)** 是精选的 commit-to-owner 恢复索引；Git 仍是完整 changelog。
5. **[design/temporary-todo.md](design/temporary-todo.md)** 只保留未完成事项。完成历史留在 Git；有长期价值的结果应写回对应的设计、决策、操作或审计文档。
6. **`experiments/`** 保存 benchmark、审计、探针和回归等观测结果。实验可以推动决策，但不能仅因测得结果就成为规范。
7. **`skills/`** 保存 Agent 工作流。Skill 说明如何维护或使用项目，并链接规范来源，不复制项目事实。
8. **`guides/`** 保存非规范的学习路径与导航图。Guide 运行公共契约并把读者路由到 owner，不重新定义设计。

文档冲突时，应修正拥有该信息的文档，而不是新增一份摘要。Git 继续承担实现历史。若某项细节有意只保留在 Git 中、但以后很难重新定位，应在相关审计或决策文档中留下 commit 或 decision 链接，而不是复制整段实现流水账。

## 目录说明

- **从这里开始：**先用[概念地图](guides/concept-map.zh-CN.md)理解术语和 owner，再运行[第一次回忆教程](guides/first-recall.zh-CN.md)。
- **`guides/`**：非规范导航与经过测试的演练。
- **`design/`**：架构、数据模型、算法和流程契约；[实现沿革索引](design/implementation-lineage.md)只记录能显著降低重新定位或重复犯错成本的 commit。
- **`decisions/`**：带生命周期的设计与流程决策，见 [decisions/README.zh-CN.md](decisions/README.zh-CN.md)。
- **`experiments/`**：测量证据。运行报告通常命名为 `<topic>-<date>.md`。相关入口包括
  [节点摘要加速检索调研](experiments/node-summary-accelerated-retrieval-2026-08-19.md)
  和当前 [benchmark 结果汇总](experiments/benchmark-results.md)。

简化判断：NMG _怎样工作或应该怎样工作_ 写入 `design/`；_为什么这样选择_ 写入 `decisions/`；_实际测到了什么_ 写入 `experiments/`。实验 commit 只有被明确的设计或决策 owner 接纳后，才会成为规范。

## 双语规则

NMG 需要双语文档，但不要求机械地逐段一致。

- 面向外部的入口文档成对维护：根目录 README、本索引和决策索引。
- 新建或实质修改决策文档时通常应维护中英文版本；项目快速变化期缺少译文只产生维护警告，不阻塞提交。
- 技术实验、临时调查和内部专题笔记可以使用最能准确保留工作的语言。
- 成对文档应互相链接，并保留相同的决策、警告和用户可见命令；段落数量和措辞不必完全对应。

## 维护流程

行为、架构、评估证据、公开说明或文档布局发生变化时，使用 [`doc-maintenance` Skill](../skills/doc-maintenance/SKILL.md)。提交文档修改前运行 `npm run docs:check`。CI 只阻止公共/规范入口破损和错误的决策结构；内部或实验文档问题、翻译漂移与缺少决策译文只作为人工复核警告。

## CI 契约

本节是自动文档检查的规则所有者。修改 `scripts/verify-docs.mts` 前先修改本表；脚本只负责实现这些规则，不得自行增加政策。

| 规则                                                                                        | 范围                                                                          | CI 结果    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------- |
| 中英文入口文件同时存在                                                                      | 根 README、docs 索引、决策索引                                                | 错误       |
| H1 与本地链接有效                                                                           | 根 README、docs 索引、规范设计基线、完成审计、决策索引与记录、每个 Skill 入口 | 错误       |
| 文件名、唯一生命周期位置、精确状态和非空必需章节符合决策契约                                | 决策记录                                                                      | 错误       |
| Skill frontmatter 包含与目录同名的 name 和非空 description                                  | 每个 `skills/<name>/SKILL.md`                                                 | 错误       |
| H1 与本地链接有效                                                                           | 其他文档及 Skill reference                                                    | 警告       |
| 内容文档位于 `design/`、`decisions/` 或 `experiments/`                                      | `docs/` 下除 README 与 AGENTS 外的直接子文件                                  | 警告       |
| 成对文档存在、互相链接且标题结构大致一致                                                    | 双语文档对                                                                    | 警告       |
| 实验运行报告文件名以 `-YYYY-MM-DD.md` 结尾；滚动汇总和笔记使用 `-results.md` 或 `-notes.md` | `experiments/` 下的文档                                                       | 警告       |
| 显式决策替代元数据使用有效的本地双向链接                                                    | 声明替代关系的决策记录                                                        | 警告       |
| 翻译质量、设计正确性、实验结论和文风                                                        | 所有文档                                                                      | 不自动判断 |

错误表示仓库公开或规范接口发生了可机械复现的破损；警告只作为 Agent 或 reviewer 的维护输入，不得导致 CI 失败。
