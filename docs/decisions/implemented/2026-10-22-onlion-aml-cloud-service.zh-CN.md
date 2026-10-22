# 单一规范源码树中的 onlion AML 云端服务

[English](2026-10-22-onlion-aml-cloud-service.md) · [Terms](2026-10-22-onlion-aml-cloud-service.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [协议边界上的共享时间证据](2026-10-22-shared-temporal-evidence.zh-CN.md)

## 问题

现成的 AML 云端应用带着第二份 vendored NMG 源码树（`vendor/nmg`），且位于未跟踪的临时目录，产品修复与已部署应用彼此漂移。AML 的有序图文契约没有可用实现，而初版方案把图片描述模型接进了写入路径——尽管协议本身随每张图片附带了描述文字。

## 决策

`onlion/` 是云端记忆应用的唯一 Git 管理源码。它导入规范根目录 `src/`（`CORE_SOURCE = "workspace:src"`）；不复制第二份 NMG 源码树、时间策略或 prompt 集。vendored 核心中唯一有效的改动（查询分词一次准备）已集中到根目录，并配有分数等价测试。

有序 `text`/`image_url` 内容按有界预算校验（仅接受 Base64 的 JPEG/PNG/WebP/GIF data URL；单图、单条内容、单请求各有上限）。检索视图由随附描述文字加不透明的单图 SHA-256 引用构成；不要求、也不会调用任何图片描述模型。原始有序 parts 保存在原生历史中并在 Search 时返回；`raw_content` 是原始证据 JSON，`content` 只附加共享的条件式时间前缀。记录按消息角色归因（`user`/`assistant`，`asserted`）；内容哈希移入标记属性，不进入检索正文。

检索索引摘要走既有 provider 机制，使用确定性抽取写入器（无模型）：叶子摘要进入叶子 FTS 路由面；节点层只在多块门限满足时刷新；节点实体词落在非身份的 `nodeSummary` 面上。节点身份名保持稳定的会话键——`canonical_name` 就是身份键，按实体派生的名字会随词频漂移把同一会话分裂成退化的单块节点。共享时间词表扩展为词边界受限的核心单位、派生词、日历名、频率与顺序词（中英文），作为既有策略下的展示数据。

仓库文本文件在仓库与工作副本中统一为 LF；Windows 脚本保持 CRLF，`.wasm` 保持二进制。`onlion/.runtime/` 存放数据集、checkpoint 与历史，保持不跟踪。构建支持 `NMG_WORKER_NAME` 与 `NMG_R2_BUCKET` 覆盖，不再继承单一托管配置。

## 考虑过的替代方案

- 保留 vendored 树：延续部署漂移和第二份策略、prompt 来源。
- 每张图片 Add 都要求视觉模型：阻塞随附描述契约，并为输入已覆盖的信息花费 token。
- 按实体派生节点身份名：随词频漂移，把一个会话分裂成退化的单块节点。
- Durable Objects SQLite 存储：不支持 `BEGIN`/`SAVEPOINT` 语句且有 2 MB 行上限；核心需要文件式 SQLite 事务与 FTS5。
- 请求时编译回调桩：Workers 禁止运行时 Wasm 代码生成（`Wasm code generation disallowed by embedder`），预编译静态模块是强制路径，生成器保留为工具链的一部分。配对实验同时证实仅 SQLite 初始化就会触发 24 次回调适配，普通 SQL 套件已部分覆盖该机制。
- 把结构化内容归因为 `assistant`/`inferred`：把从未经过模型的用户随附描述错误归因。

## 后果

一份 NMG 实现同时服务 CLI/daemon 与云端应用；`onlion/` 无法脱离工作区检出构建，`dist/` 产物才是可部署工件。契约测试在 Miniflare 与模拟 R2 中运行，不调用外部模型。真实图片描述路径被有意移除；真实 provider、生产部署、官方评测与完整 benchmark 分数均未执行。服务响应包含超出 AML 必填范围的字段（`task_id`、`status`、`added`、`stored_at`、`event_time`、`raw_content`），多模态 `content` 携带时间前缀——这是此处记录的、由撤回安全投影约束的有意展示偏差。
