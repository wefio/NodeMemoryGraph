# DSH 与 OpenCode 原生插件能力核实

[English](native-plugin-capabilities-2026-11-12.md) · [术语](native-plugin-capabilities-2026-11-12.terms.yaml)

## 问题与结论

DSH、OpenCode 的哪些 NMG 缺口能原生补齐？两者都提供原生上下文、工具及生命周期接口。两个适配器已接完整工作状态承载。DSH 还接上最终工具结果观察、弱 commit 提醒与已提交完成回合的诊断归因。OpenCode 在首回合召回前查询会话目录，并以显式 `nmg_` 名称注册工具。

Magpie 保持完整独立插件目标，原生路径不依赖网关部署。[既有能力矩阵](../../design/harness-capability-matrix.zh-CN.md)拥有源码覆盖情况，[OpenCode 决策](../../decisions/implemented/2026-10-17-opencode-adapter.zh-CN.md)保留原始集成证据。

## 目标与证据强度

| 目标 | 证据 | 限制 |
| --- | --- | --- |
| NMG 适配器 | 28 项针对性 fixture 通过，另有共享工具合同与传输测试 | fixture 模拟宿主回调，不能建立全部原生生命周期顺序 |
| DSH 源码 | 公开提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，checkout 清单 `0.2.1-rc.2` | 源码版本与已安装版本分别记录 |
| 已安装 DSH 核心包 | prompt／tools／Agent 包 `0.2.1-rc.5`，产物记录模块 SHA-256 | 真实 Cordis、prompt、tools 服务，Agent／会话事件为合成；未运行完整 Agent 循环、桌面或外部模型 |
| 已安装 OpenCode | CLI `2.0.32`，记录二进制 SHA-256；私有 HTTP 宿主加载实际 NMG 插件、私有 NMG 服务与本地模拟模型 | 三个准入 prompt、原生手动压缩及确定性工具循环；未调用外部供应商，未验证 GUI 或真实空闲唤醒 |

[产物](artifacts/native-plugin-capabilities-2026-11-12/native-plugin-probe.json)记录源码哈希、包版本、已测项和未验证边界。源码审查不是运行证据。本地模拟模型收据只支持该次运行，不能授权生产披露收据。

## DSH 原生运行

固定源码提供[上下文装配](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/system-prompt/src/index.ts)、[请求准入与刷新](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts)、[最终工具通知](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts)及[已提交会话事件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts)。

已安装服务验证动态上下文刷新、按传入身份选择装配、撤销贡献，以及冻结后的最终成功／错误工具通知。NMG 联调还通过真实原生工具启用／替换状态，准入请求，装配完整状态与召回，搜索／精确读取证据并落盘完成回合的诊断归因。这是合成 Agent 事件下的服务合同验证，未运行完整原生执行循环。

适配器在 inbox 到达时启动召回，在请求准入时等待有界准备。原生循环在提交模型可见内容前刷新同步 `systemPrompt.context` 贡献。共享 `contextStateViews` 与 InformationView 保留完整状态，独立于召回结果。最终 `tools/result` 走共享观察筛选与 commit 提醒。已提交 `assistant/message` 只在完成的 `turn/end` 上归因，取消、外部会话与重复结束事件不产生归因。诊断重合不是正确性或训练反馈。

## OpenCode 激活与 hook 联调

初次仅 API 的会话／配置查询没有 setup 回执，以 2 退出。使用不存在 provider 的 CLI 探索超时。两者都不能建立插件支持或不支持的结论。成功联调使用新的私有 HTTP 宿主，在会话实际运行时激活插件。

已安装 SDK 提供 `session.get`、`wait`、`context`、`prompt`，以及 prompt／context／compaction hook。联调记录实际 prompt、context 与 `execute.after` 回调。本地模拟模型通过 Code Mode 调用 `tools.nmg_search`、`tools.nmg_get` 和 `tools.nmg_state`。下一个准入 prompt 将完整工作状态带入后续模型请求。宿主把注入 system 块转换成转义的 `system-update` 正文，收据检查明确识别此形式。

SDK 不给新增工具应用 `options.namespace` 前缀，因此 NMG 显式注册 `nmg_search`、`nmg_get`、`nmg_remember` 和 `nmg_state`。原生 `session.get` 在召回前提供首回合作用域，插件 location 回退，显式项目配置覆盖。截止时间测试阻止迟到查询修改当前作用域。可选召回超时仍保留已准入的完整状态。

已安装宿主验证 prompt、context、工具完成及手动压缩 hook。原生压缩后，下一个 prompt 将当前完整工作状态带入本地模拟接收端。取消与迟到准备拒绝另有 fixture 覆盖。中断／自动压缩、fork 和重连时序仍待验证。

## 限制与剩余验证门槛

| 边界 | 已确认限制或剩余问题 |
| --- | --- |
| DSH 同步 context 回调 | 不能在此等待 daemon I/O；应在异步准入准备并提供有界快照 |
| DSH `agent/request` | 替换调用配置，不修改 messages；内容走有日志的上下文通道 |
| DSH `tools/result` | 观察最终结果，不是授权否决入口 |
| OpenCode 执行完成 | 不建立真正空闲；历史证据未观察到 `session.created` 或 `session.idle` |
| Claim outcome | 原生工具身份本身不建立合格 lineage 或正确性见证 |
| 原生生命周期 | fork／reset／重连代次、真实空闲唤醒和桌面加载需要独立运行证据 |
| 最终投递 | 上下文准备仍未确认；本地模拟接收端是实验见证，不是通用最终发送 API |

不从缺少 NMG handler 推断宿主无法实现功能。Magpie／原生组合仍需认证会话交接、共享预算和选定的单一效果所有者。

## 复现

使用明确安装路径运行保留的[探测脚本](native-plugin-probe.mjs)：

```text
node docs/experiments/runtime/native-plugin-probe.mjs --dsh-package <dsh/package.json> --opencode-bin <opencode-cli.exe> --output <evidence-directory> --exercise-hooks
```

命令拥有私有宿主配置、本地监听器和私有 NMG 存储，完成后关闭自有资源。不重启共享宿主、不改生产配置、不使用外部模型／向量凭据。不带 `--exercise-hooks` 时，API-only 证据可以保持不完整并以 2 退出。完整联调只在断言通过后退出 0，失败保持非零。保留元数据和合成标记摘要，不保存供应商凭据或完整模型请求。

针对性合同测试：

```text
node --experimental-strip-types --test tests/integration/automatic-recall-opencode.test.ts tests/integration/coordination-opencode.test.ts tests/integration/opencode-board-args.test.ts tests/extensions/dsh-state.test.ts
```

[选定 API 片段](artifacts/native-plugin-capabilities-2026-11-12/opencode-contract.json)有意省略无关定义，不替代 SDK。[Magpie 设计](../../design/unified-architecture/magpie-integration.zh-CN.md)消费这些原生结论，同时保留完整独立插件与组合会话验证。
