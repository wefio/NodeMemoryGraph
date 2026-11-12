# DSH 与 OpenCode 原生插件能力核实

[English](native-plugin-capabilities-2026-11-12.md) · [术语](native-plugin-capabilities-2026-11-12.terms.yaml)

## 问题与结论

DSH、OpenCode 的哪些 NMG 缺口能原生补齐，哪些确实需要网关？既有[适配器矩阵](../../design/harness-capability-matrix.zh-CN.md)与 [OpenCode 决策](../../decisions/implemented/2026-10-17-opencode-adapter.zh-CN.md)是起点，不应当作缺失规范重建。

两者都提供核心 NMG 集成所需的原生路径。本次未发现证据表明工作状态承载、记忆工具、工具结果观察、诊断归因或黑板访问必须依赖 Magpie。这不表示 NMG 对应接线已实现或端到端验证，剩余问题涉及集成、时序与证据语义。

## 目标与证据强度

| 目标 | 证据 | 限制 |
| --- | --- | --- |
| NMG | `970e70ee` 源码与 20 项通过的适配器 fixture 测试 | 测试执行 NMG 适配器、模拟宿主入口及私有 HTTP 服务，不是真实桌面宿主 |
| DSH 源码 | 公开提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，checkout 清单为 `0.2.1-rc.2` | 源码审查与已安装包探测分别记录 |
| DSH 已安装核心包 | `dsh-system-prompt`、`dsh-tools`、`dsh-agent` `0.2.1-rc.5`，产物记录模块 SHA-256 | 只运行 prompt／tool 服务，未运行桌面 bundle 和完整 Agent 循环 |
| OpenCode | 已安装 CLI 版本文件 `2.0.32`，记录二进制 SHA-256，执行私有 `api --standalone` 请求 | CLI 的 API 描述服务器操作，不等于完整进程内插件 SDK |
| 历史 OpenCode 运行 | 10 月 17 日决策记录真实 2.0.32 召回注入、Code Mode 工具和执行结束归因 | 本次未重跑依赖真实 provider 的流程 |

尝试的 GitHub 路径未取得 OpenCode 2.0.32 的准确源码／SDK，没有以当前或 v1 SDK 替代。DSH 已安装声明也确认所审查的原生事件名，但不因名字相同就认定版本相同。

## DSH 原生合同

固定源码提供以下具体路径：

| NMG 行为 | 原生路径 | 分类 |
| --- | --- | --- |
| 维护状态进入模型上下文 | [`SystemPrompt.context`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/system-prompt/src/index.ts)，由 [Agent 循环](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts)在请求准入刷新 | 原生路径可用，NMG 专用状态准备／承载仍需接线和测试 |
| 工具结果进入 AG 与完成提醒 | [`tools/result`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts)携带执行身份通知最终结果，包括错误；前／后执行 waterfall 是独立入口 | 原生结果路径可用，NMG 观察筛选与 lineage 映射属于实现工作 |
| 诊断答案归因 | [`agent/turn-stopping`、`agent/status`、`agent/assistant-stream`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts)与 [`session/event`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts) | 原生边界存在，归因落盘前选择已提交答案事件并验证取消／续接回合 |
| 忙闲与定向唤醒 | Agent status、`send`、`followup`、`steer`、销毁及原生会话身份 | NMG 已接入部分路径，无须从网关静默推断空闲 |
| clear／compact／resume 隔离 | Agent 创建来源包括 startup／resume／clear／compact，提供会话日志和生命周期事件 | 映射到 NMG generation／fence 需要端到端验证 |

已安装 prompt／tool 探测通过四项检查：动态上下文刷新、按传入装配身份选择内容、撤销贡献、最终成功／错误结果冻结通知。身份检查不等于认证或租户隔离测试，也不证明 NMG 状态已发给真实模型。上述 Agent 生命周期事件经过审查，没有在服务级探测中运行。

## OpenCode 原生合同与实际 API

既有 NMG 绑定使用 `ctx.session.hook("prompt"|"context"|"compaction")`、`ctx.tool.transform`、`ctx.tool.hook("execute.after")`、事件订阅和 `ctx.session.prompt`。10 月 17 日记录提供历史运行证据，将此适配器的上下文 hook 称为 `llm` hook 不准确。

私有 CLI 服务还实际返回以下 API：

- `session.get` 返回 `Session.Info`，包含必需的 `location` 及可选 parent／fork／outcome 字段。
- 存在 `session.context`、`session.prompt`、`session.compact`、`session.fork` 和 `event.subscribe`，会话日志端点标为 experimental。
- 创建合成会话后，在任何 prompt 之前通过 `session.get` 读回目录。因此晚到的事件映射是 NMG 查询实现的限制，不证明 OpenCode 无法提供首回合作用域。插件 SDK 映射及截止时间行为仍需测试。

私有 config API 确认合成插件配置存在，但仅 API 的会话／配置查询没有产生插件 setup 回执，插件列表为空。这没有复现推理期间的插件激活。保留的探测以 **2** 退出，如实保留不完整结果，不是完整通过的插件 smoke。另一次使用不存在 provider 的探索性 CLI run 超时，没有提供更多证据，不宣称该尝试完成推理或触发 hook。

## 实际限制与未确认问题

| 观测 | 排除的方式 | 仍可采用的路径 |
| --- | --- | --- |
| DSH context text 回调同步返回字符串 | 在该回调本身等待 daemon I/O | 在获准原生边界异步准备，再提供有界快照；测试刷新与取消时序 |
| DSH `agent/request` 替换冻结调用配置，不能修改 messages | 用该 hook 任意改写未入日志的消息 | 内容走有日志的 `SystemPrompt.context` 通道 |
| DSH 最终结果通知是观察，监听失败被隔离 | 把 `tools/result` 当授权否决入口 | 门禁走前执行策略及其受支持语义 |
| 既有 OpenCode 2.0.32 smoke 未观察到 `session.created`／`session.idle` 通知 | 依赖这两个确切事件名完成初始化／收尾 | 查询会话信息并使用 execution 事件，队列／空闲／重连的精确语义仍待验证 |
| 准备上下文与执行成功不提供正确性见证 | 将其当作最终 provider 投递、记忆正确性或正向反馈证明 | 分开保存投递证据、诊断重合与显式受支持反馈 |

不从缺少 NMG handler 推断核心功能做不到。Claim outcome lineage、fork／reset／重连代次、真实空闲唤醒、取消与最终输入收据保留集成验证门槛。存在 HTTP API 不证明存在等价插件方法或对应回调时序。

## 复现与使用

使用明确安装路径运行保留的[探测脚本](native-plugin-probe.mjs)：

```text
node docs/experiments/runtime/native-plugin-probe.mjs --dsh-package <dsh/package.json> --opencode-bin <opencode-cli.exe> --output <evidence-directory>
```

脚本使用真实已安装 DSH 服务和私有 OpenCode 配置，记录元数据／合成标记并清理一次性配置，不重启共享 daemon、不改线上配置、不调用真实 provider。退出 0 要求有合成插件注册回执，退出 2 保留部分证据，其他失败保持非零。

[结果](artifacts/native-plugin-capabilities-2026-11-12/native-plugin-probe.json)记录版本、模块／二进制摘要及已测／未验证范围。[选定 API 片段](artifacts/native-plugin-capabilities-2026-11-12/opencode-contract.json)记录 schema 摘要并有意省略无关 schema，不替代 SDK。

适配器 fixture 执行命令如下：

```text
node --experimental-strip-types --test tests/integration/automatic-recall-opencode.test.ts tests/integration/coordination-opencode.test.ts tests/integration/opencode-board-args.test.ts tests/extensions/dsh-state.test.ts
```

20 项全部通过，只支持既有 NMG 接线及回归覆盖。[归属矩阵](../../design/harness-capability-matrix.zh-CN.md#原生宿主能力核实)负责分类缺口，Magpie 设计消费该分类，同时保持插件完整、可独立使用的目标。
