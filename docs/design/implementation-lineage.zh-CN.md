# 实现沿革索引

[English](implementation-lineage.md) | [简体中文](implementation-lineage.zh-CN.md)

**状态：**当前
**Authority：**本文将实现历史映射到当前 owner；它不替代规范性[系统设计](design.zh-CN.md)、决策、实验或[完成审计](completion-audit.md)。

## 为什么需要此索引

Git 保留了完整实现历史，但单独的 hash 无法说明当前由哪份契约负责。因此，只有当某个提交能帮助未来 Agent 找回机制来源、理解加固修复，或避免重复已放弃的设计时，主题 owner 才保留简短的 `Implementation lineage` 小节。本索引是经过筛选的导航，不是第二份 changelog，也不要求把每个提交都抄进文档。

## 沿革标记

主题 owner 使用以下四个标记，而不是重写 changelog：

- **Introduced** — 首次建立该能力的提交。
- **Hardened** — 修复或补齐仍然有效的契约。
- **Validated** — 提供测试或测量证据；不表示默认激活。
- **Superseded** — 已被当前替代方案取代的历史实现。

机械格式调整、生成产物、依赖刷新、普通测试、merge commit、会话元数据，以及容易从 owner 代码中找到的实现细节仍保留在 Git。只属于实验的提交留在相应运行报告中。只有在能实质降低重新发现成本或回归风险时才记录 hash。

## 当前契约 owner

| 能力 | 持久沿革 | 当前 owner |
| --- | --- | --- |
| 基础 Pi memory、受治理写入、类型化记录与 Lite 包 | **Introduced** `3e67c6ca`；**Hardened** `19d284bb`、`a17fdfdd`、`199da9bd`、`412219b7` | [系统设计](design.zh-CN.md)、根 README |
| Agent 无关 CLI 与常驻 daemon | **Introduced** `87cbc3d5`、`39516537`；gRPC `9444a3c1` → HTTP JSON-RPC `692fe85c` **Superseded**；**Hardened** `80167da9`、`11e2101f`、`9a911d00`、`ac2d1114` | [系统设计](design.zh-CN.md)、[daemon 生命周期](daemon-lifecycle-design.zh-CN.md) |
| 具 session 行隔离的共享 STG | **Introduced** `1d8b21df`；**Hardened** `48d64e29`、`25260270`、`6f755217`、`9a911d00` | [STG shared-store v2](stg-shared-store-v2-2026-08-12.md) |
| QPP、渐进召回与可学习控制器通道 | **Introduced** `dd41829e`、`2bb92098`、`1ae9e501`；**Hardened** `c369fa0b`、`4074eb19`、`9e7168e7`、`4a2f7ff1`；**Validated** `87d02423` | [检索充分性与控制器边界](retrieval-confidence-controller.zh-CN.md) |
| 状态 supersession、claims、posterior 与可逆巩固 | **Introduced** `7b9849a3`、`a689c6e7`、`0b9a91e0`；**Hardened** `172a80ef`、`3e3b5eda`、`536f3439`、`a14f7828`、`12903701` | [系统设计](design.zh-CN.md)、[supersession](supersession-design.md) |
| Session hooks 与有界推理暂存区 | **Introduced** `06d3f8ac`、`14cf0e89`；**Hardened** `fd086859`、`d05c3cfd`、`86d80c4e` | [Session lifecycle hooks](session-memory-lifecycle-hooks-2026-08-10.md) |
| 跨 harness 的 Lab capability lease 与 daemon 拥有的 reasoning/MGR 调用 | **Introduced** `f8cbb9f` | [系统设计](design.zh-CN.md)、[完成审计](completion-audit.md) |
| Task Board 与本地 A2A 风格的发现／交付 | **Introduced** `79a099de`、`5d09c4e1`；**Hardened** `9e097253`、`7b2bda5a`、`80506586`、`3641b3af`、`3f9d62be`、`b792f3af` | [Board/A2A compatibility](board-find-serial-a2a-compat-2026-08-13.md) |
| 时间／逻辑 memory chain | **Introduced** `155d88c9`；**Hardened** `d0a1cc03`、`fbc45e51`、`a126382a`、`cb4a858a`、`6db50df8`；**Validated** `2f068cfc`、`f5598a8c`、`f4977cf2` | [Temporal/logical chains](temporal-logical-chains-design-2026-08-13.md) |
| Leaf/node summary 与 summary routing | **Introduced** `1feb008d`、`ecde4e45`；**Hardened** `796439ed`、`5a0edbf5`、`20de2efc` | [Tiered disclosure](tiered-disclosure-design.md)、node-summary 实验系列 |
| Natural evidence 与激活 gate | **Introduced** `cc0fa383`、`c815dfd1`；**Hardened** `f49db9d1`、`9fa0872c`、`a14f7828`；**Validated** `fd62ed06`、`571e4bbf` | [检索充分性与控制器边界](retrieval-confidence-controller.zh-CN.md)、[完成审计](completion-audit.md) |
| 文档、CI 与 Agent 开发工作流 | **Introduced** `00d4a285`、`40c8e22e`、`75d9da39`；**Hardened** `8319e7e0`、`8b4ac943`、`11ab3b56`、`8061679`、`ea98ea4` | [文档索引](../README.zh-CN.md)、[CI 与质量](ci-cd-and-quality.zh-CN.md) |
| Session Active Graph 运行时（daemon 拥有的工作记忆） | **Introduced** protocol v9 与 `SessionActiveGraphRuntime` core；**Hardened** task-frame/branch 生命周期、统一的 session-wide 预算、TTL 推理产物、disclosure ledger | [Session AG runtime](session-active-graph-runtime-design.zh-CN.md)、[AG runtime 决策](../decisions/implemented/2026-08-29-session-active-graph-runtime.zh-CN.md) |
| 搜索的文件内容来源 | **Proposed**（2026-09-01）：对 `.nmg-search-scope` 热区做有界被动扫描；从 Agent grep/read 行为学习 scope；lexical-first FTS index；memory 与 file fusion | [File content source](archived/file-content-source-design.md) |

Pi 依赖边界有意由 package manifest 与契约测试表示，而不是另造一个子系统：harness API 是可选 peer/type 依赖；`pi-tui` 仅在 adapter UI 与延迟加载的 `nmg inspect` TUI 中作为 runtime 依赖。

## 维护规则

新提交只有在持久契约、理由、证据状态、公共操作或高成本失败模式发生变化时，才更新现有主题 owner。按上面的标记把 hash 加到对应 owner 的沿革中。如果提交仅涉及实验、机械变动，或可从代码轻易重新发现，就留在 Git 或实验报告中，不要扩展规范性设计文档。此工作流由 [`doc-maintenance` Skill](../../skills/doc-maintenance/SKILL.zh-CN.md) 负责。
