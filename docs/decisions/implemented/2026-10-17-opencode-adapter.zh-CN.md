# OpenCode V2 适配器作为薄传输插件

[English](2026-10-17-opencode-adapter.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [共享会话流转上移集成层](2026-10-16-shared-session-flows.zh-CN.md),
[harness 适配器为薄传输](../../../skills/nmg-memory/references/harness-adapters.md)

## Problem

OpenCode 是继 pi 之后第二个必须运行 NMG 的 harness，且不允许把能力逻辑复制进
适配器。宿主 API 与 pi 有三处承重差异：插件在共享后台服务内加载、模块按进程
缓存；插件事件流既不发出 `session.created` 也不发出 `session.idle`；供应商
step 重试会从转录重建请求上下文，丢失插件上一次推入的任何消息。按 pi 假设
编写的适配器在每次重试时静默丢失注入、永不落盘归因、会话无法映射。

## Decision

`opencode-plugin/` 是与既有 `workbuddy-plugin/` 同风格的薄传输插件：包根为
`index.ts`、`rpc.ts`、`tui.ts` 与经 exports 解析的 `package.json`；项目安装
是 `.opencode/plugins/` 下一个可指向仓库的 junction 入口（在 OpenCode 2.0.32
实证透明，顶层 `.ts` 文件与目录包均可）。

- 只做传输：能力一律从 `src/integration/*` 与 daemon RPC 导入；模型可见的
  记忆文本由 `src/integration/agent-surface.ts` 渲染。daemon lease 经
  `src/integration/lease-transport.ts` 打开（活跃 lease HTTP 端口上的
  JSON-RPC），一次性 CLI 为兜底；插件永不 own/start/stop daemon。
- 工具以 Code Mode 的 `nmg` 命名空间注册，宿主侧呈现为 `nmg_search`、
  `nmg_state` 等；`tests/integration/tool-contract.test.ts` 的工具契约行
  校验 schema。
- 自动召回在 `prompt` 准入时暂存（约 1.5s prompt 预算封顶），由 `context`
  钩子以 system-role parts 数组投递进可变 `messages`；字符串负载会令
  provider 落层崩溃。
- 暂存注入在整个执行期间保持：供应商重试后的重投由内容判定 —— 扫描
  system-role 消息中的召回前言头；重建的请求上下文会重新获得该块，而已
  携带它的 step 工具请求不会重复。收尾在
  `session.execution.succeeded`/`session.execution.failed`（以及其他构建
  发出 `session.idle` 时）清除暂存与装备状态。
- `session.execution.succeeded` 承担 idle 同义角色：归因落盘、按
  `opencode` 命名空间身份锚点的 `registerAgent` 心跳、注入收尾。缺失的
  会话行视为根会话（`child: false`），`parentID` 事件粘性升级。
- 项目目录映射来自任何携带 `event.location.directory` 的事件（
  `session.inbox.delivered`、`session.tool.called`）；executor 上下文不
  携带目录，`NMG_PROJECT_DIR` 仍是显式覆盖手段。

本地化差异已记入矩阵页：2.0.32 的插件事件流（`session.execution.succeeded`/
`failed`、`session.retry.scheduled`、`session.inbox.*`）取代 pi 时代的
`session.created`/`session.idle`；`ctx.tool.transform` 携带
`{ namespace: "nmg", codemode: true }` 是实证过的注册调用；服务级插件模块
缓存意味着插件代码改动只在新进程生效（`opencode run --standalone` 或共享
服务下一次重启）。

验证在 Windows 上的 OpenCode 2.0.32 进行，maimaidx 免费 lane 提供
`glm-5.3-flash-free`；opencode-zen 匿名 lane 持续上游 403（已按公开请求形
状复现），不可用。standalone smoke 证实：新进程上 setup 与钩子触发、注入
的召回头到达模型、`nmg_search`/`nmg_state` 经 Code Mode 端到端命中存活
lease、`execution.succeeded` 写出 `~/.nmg/agents/<session>/identity.json`。

## Alternatives considered

- 在插件内分叉 pi 流转。拒绝：重复策略会漂移 —— 适配器边界命名的缺陷。
- 暂存注入一次性消费。实测后拒绝：首次重试即丢失召回块（2.0.32 实证），
  故投递改为内容扫描且作用域为整个执行。
- 由 `session.retry.scheduled` 装备重投。拒绝：重试事件可能晚于首次请求
  消费暂存体；事件顺序不是投递契约。标记扫描不依赖事件。
- 把流转推入 daemon、插件少转发调用。暂拒绝：回收窗口与注入暂存是亚秒级
  预算的会话内状态；RPC 往返会给每次准入的回合加延迟。

## Consequences

- 能力矩阵（`docs/design/harness-capability-matrix.md`）依据本记录与上述
  smoke 得出 opencode 列；核心召回/工具/归因路径为完整，宿主无事件或目录
  信号处为部分。
- 已知部分项：新起进程的首回合尚无任何事件映射目录，召回搜索在首次事件到
  达前不限定项目（次回合起收窄）；归因落盘粒度为每次执行而非真正 idle；
  TUI `/nmg` 控制台与 wake 循环已接线但未做 live smoke（wake 逻辑与 pi 共
  享，由 `tests/integration/session-flows.test.ts` 覆盖）。
- 已安装宿主上的插件代码改动仅在与新服务进程时生效 —— 共享服务的一条已
  记录运维属性。
- `lease-transport.ts` 与工具契约 `opencode` 侧行供未来适配器复用；
  `agent-context.yaml` 与 format/`pre-commit` 表面已登记 `opencode-plugin`
  （由 `tests/tools/test-groups.test.ts` 强制）。
