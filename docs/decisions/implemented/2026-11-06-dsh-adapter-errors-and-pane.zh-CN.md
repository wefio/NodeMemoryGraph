# DSH 适配器：领域错误、会话绑定与右侧栏召回面板

[English](2026-11-06-dsh-adapter-errors-and-pane.md) · [术语](2026-11-06-dsh-adapter-errors-and-pane.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

`@nmg/dsh-nmg` 宿主适配器把所有 daemon 拒绝都当成传输失败。`daemonCall` 先判
`!response.ok` 再解析响应体，于是带可执行原因的 JSON-RPC error（"显式 STG 写入需要
sessionId"、"state AG requires an enabled host binding"）被吞掉，daemon 句柄被清空，
调用降级到 CLI；CLI 重复同一请求，报出原始 JSON-RPC 信封，模型看到的是
`NMG exit 1: {"jsonrpc":…}` 而不是原因。不经过 CLI 的路径里，一次被拒的
`nmg_remember` 还会显示成 `NMG daemon is unavailable for resolveRemember`。

同时带出三个较小缺陷。`nmg_remember save` 从不发 `sessionId`，会话级临时写入被直接
拒绝；`nmg_get` 复用上一轮的 `activeGraphId`，而它属于上一轮的 agent 会话，必被拒；
`nmg_state` 用共享的 board/AG 参数表校验 AG 字段，模型照工具 schema 填参数就会撞
"Unsupported AG state field"。

浏览器半边另有一个可拖拽缩放的召回浮标压在会话之上：遮挡内容、在框架里没有入口，
而且这些信息放在侧栏里不需要盖住任何东西。

## 决策

在 `daemonCall` 里一次性分开领域拒绝与传输失败：先解析响应体，带 `error` 就抛专用的
`NmgRpcError`，放在任何状态码分支之前。`invoke` 与 `invokeRpcOnly` 原样返回该消息，
不再折叠成 `NMG call aborted` 或 `daemon unavailable`；领域拒绝时 `daemonCall` 保留已
解析的端点，因为 daemon 是可达的。

`disclose` 改为尽力而为：被拒时降级为"本轮还什么都没展示过"，而不是让整次召回失败。
`nmg_get` 在 daemon 判定 id 属于别的会话时，去掉 id 重试一次。`nmg_remember save` 带上
会话 id。`nmg_state` 在校验前把 AG 请求裁剪到 `STATE_AG_FIELDS`：共享 schema 保留，
两个空间各按自己的规则校验。

浮标改为经 `sidebarRightTabs` 注册的右侧栏 tab（`nmg-recall`），仍按最新在前的顺序渲染
召回轮次，并增加一张活动账本（召回、搜索、证据展开）。账本由宿主保存在内存里，经
`/nmg/recall` 提供给浏览器；当浏览器的会话 id 与宿主的不一致时，回退到最近产生过活动
的那个会话。

## 考虑过的替代方案

- 任何非 2xx 都继续走 CLI 兜底。这会重复一次已经被拒绝的写操作，并把原因埋进子进程结果。
- 靠提示词让模型避免 AG 不接受的字段。schema 是共享的，靠指令遵守不是校验层。
- 保留浮标并加隐藏按钮。浮标仍然遮挡会话，而且再加一套位置记忆比一个 tab 更费代码。
- 用 daemon 的持久 trace 驱动右侧栏。这个 tab 是本会话适配器工作的实时视图；持久记录
  已经由 daemon 拥有。

## 后果

工具失败现在会说明原因并保留 daemon 句柄，一次坏调用不再让本轮余下的快路径失效；会话级
写入落到正确的会话；一次被拒的披露不再拖垮召回。

活动账本是进程内的：随 DSH 宿主重启清空，每会话上限 60 条。面板里的召回历史仍受既有的
五轮上限约束。需要持久的内容依旧来自 daemon。
