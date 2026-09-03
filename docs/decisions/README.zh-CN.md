# NMG 决策记录

[English](README.md)

决策记录保存无法从当前设计或 Git 差异中安全还原的理由。它们解释非平凡的架构和流程选择；规范行为仍由 `docs/design/` 定义。

## 生命周期

- `proposed/`：开放提案。必需章节：问题、提案、考虑过的替代方案、验收标准、风险。
- `implemented/`：已接受并实现的决策。必需章节：问题、决策、考虑过的替代方案、后果。
- `rejected/`：保留供以后参考的被拒提案；保留提案与替代方案，并说明拒绝原因。
- `archived/`：曾经实现、但已不再约束当前系统的决策；写明归档日期和后继者（如有）。

目录表示生命周期，每份记录还应包含一致的 `Status:` 行。状态变化时移动文档，不要复制到另一个目录。
决策文件使用 `YYYY-MM-DD-kebab-case.md`；译文在 `.md` 前增加 `.zh-CN`。同一个带日期的 slug 只能存在于一个生命周期目录。必需章节必须包含正文，不能只有标题。

创建记录前先搜索已有的信息所有者。同一决策被细化时更新原记录；完全替代时双向链接并归档旧记录；部分替代时保留双方并明确剩余适用范围。使用元数据时，采用本地 Markdown 链接，双方必须互相指向：

```markdown
**Supersedes:** [旧决策](../archived/2026-01-01-old-decision.md)
**Superseded by:** [新决策](../implemented/2026-02-01-new-decision.md)
```

决策记录通常应提供互相链接的英文版和 `.zh-CN.md` 版。缺少译文只产生警告，不作为硬错误。

## 开放提案

- [会话级 Active Graph 运行时](proposed/2026-08-29-session-active-graph-runtime.zh-CN.md)

## 已实现决策

- [外部 Repository Control Plane](implemented/2026-08-29-repository-control-plane.zh-CN.md)

## 被拒决策

- [将构建产物纳入版本控制](rejected/2026-09-02-track-build-artifacts-in-git.zh-CN.md) — 可再生输出保持不入库；可构建性靠验证而非提交
- [书签功能继续命名为 "anchors"](rejected/2026-09-02-keep-bookmarks-named-anchors.zh-CN.md) — 改名为 tessera，终结与 surface/task/support anchors 的撞名
- [本地哈希向量作为检索兜底](rejected/2026-09-03-hashing-vector-retrieval-fallback.zh-CN.md) — 作为语义检索信号被拒（256 维实测零增益）；词法级用途仍是开放候选
