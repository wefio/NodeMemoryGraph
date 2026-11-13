# Codex 原生插件能力联调

[English](codex-plugin-capabilities-2026-11-13.md) · [术语](codex-plugin-capabilities-2026-11-13.terms.yaml)

## 结果与范围

NMG 已通过 Codex 原生本地插件安装路径运行。已安装插件提供现有 NMG MCP 服务和
Skill，并携带使用共享能力装配的源码绑定 hook fixture。
确定性的 Responses 流量只发往本地回环监听器，记忆位于私有 NMG owner。
未修改生产配置或共享宿主，未使用外部模型／向量凭据。

| 能力面 | 实测结果 |
| --- | --- |
| 插件安装 | 本地 marketplace 添加、安装、列举成功，使用已安装缓存副本 |
| Skill | 明确调用后，打包的 NMG Skill 进入模型请求 |
| 显式工具 | 五个工具进入原生工具目录，search、精确 get、remember、状态 enable／replace 和 Lab list 均通过 MCP 执行 |
| 自动上下文 | UserPromptSubmit 调用装配后的召回／状态投影，输出到达本地模型 |
| 连续性 | 恢复同一 Codex 聊天，下一用户回合收到完整维护状态标记及末尾约束 |
| 原生事件 | SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop 均执行，两回合记录 18 次事件 |

测试对象为桌面应用随附引擎 `0.167.0-alpha.4.1` 和独立 CLI `0.167.2`。
执行使用其 CLI 和 app-server 接口，没有操作桌面 GUI。
回执保留二进制／源码哈希、模型请求标记摘要及原生事件元数据，不保留完整提示词或凭据。
响应中的 usage 是模拟数据，不代表实际用量。

## 联调发现的条件

[官方打包说明](https://developers.openai.com/plugins/build/plugins)推荐根目录 `plugin.json`，
并保留 `.codex-plugin/plugin.json` 兼容路径。
在测试的二进制中，便携根清单及根清单加 overlay 的 fixture 可以加载 MCP／Skill，
但 `hooks/list` 没有列出插件 hook。只使用兼容清单后，hook 被识别为 `source=plugin`。
这是特定版本的实测，不推断所有版本都不支持便携 hook。
保留 `--layout portable|overlay` 作为负对照，hook／上下文检查失败时不能报全通过。

其他条件：

- 这些版本默认关闭 hooks，私有配置显式启用 `features.hooks`。
  发现 hook 不等于已经执行。
- 实验对自己刚生成并审阅的 fixture 命令显式绕过持久化信任检查，没有修改用户信任记录。
  正常安装仍遵循[hook 审阅流程](https://learn.chatgpt.com/docs/hooks)。
- 插件 MCP 工具默认需要审批。私有探针为自己的服务授权，才能在 never-ask 策略下运行。
  工具虽然列出但调用被拒绝时，不计为执行成功。
- 便携 MCP 接受 `node` 这样的裸可执行名，绝对可执行路径被便携加载器拒绝。
- 本机 Windows 下，`node "${PLUGIN_ROOT}/hooks/run.mjs"` 可以执行，
  以带引号的绝对可执行路径开头则未能运行 fixture。解释器查找属于宿主安装条件。
- Responses 的 namespace 调用分别传 `namespace` 和 `name`。
  将两者用点拼成一个名字会被原生路由器拒绝。

## 证据边界与剩余工作

fixture 将一个私有 Codex 聊天绑定到操作方明确选择的 NMG session，MCP 使用相同绑定。
hook 的原生 session／turn ID 被记录，不作为模型自行提供的授权。
这个受控映射没有实现生产会话发现、多个并发聊天或 fork、reset／重连代次。

hook 使用 `assembleAdapterCapabilities`、InformationView 和当前 owner 状态。
准备不写投递／披露回执，回环接收端只作为实验见证。
工具前后事件被记录以验证宿主边界，不构成已交付的通用工具捕获或答案归因绑定。
压缩、空闲唤醒、子 Agent、事件取消及桌面安装交互尚未在这里验证。

目前仍没有正式交付独立 NMG Codex 适配器。
成功的源码绑定插件 fixture 说明，NMG 尚未接线不能归因为宿主做不到，
Codex 原生能力补齐可以独立于 Magpie 推进。

## 复现

使用已准备好的持久 NMG checkout，并明确选择二进制：

```text
node docs/experiments/runtime/codex-plugin-probe.mjs --codex-bin <codex.exe> --layout compatibility --output <evidence-directory>
```

[探针](codex-plugin-probe.mjs)创建私有 Codex home、本地 marketplace、已安装插件副本、
模型监听器和记忆 owner，关闭子进程 stdin，限制命令／请求时限，检查实际记忆 RPC 和
收到的上下文，并清理其资源。[hook fixture](codex-probe-hook.mjs)依赖本 checkout 源码，
生成包不是可分发的生产插件。

保留证据：[桌面引擎](artifacts/codex-plugin-capabilities-2026-11-13/desktop.json)、
[独立 CLI](artifacts/codex-plugin-capabilities-2026-11-13/cli.json)、
[便携清单负对照](artifacts/codex-plugin-capabilities-2026-11-13/portable-control.json)。
