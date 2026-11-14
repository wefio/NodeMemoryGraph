# Codex 的 NMG 插件

[English](README.md)

插件提供 NMG 记忆／状态工具，以及原生召回、维护状态和协作 hook。
PATH 需提供 Node.js 22.19+，并已有兼容的本机 NMG daemon。
打包客户端运行时不依赖此 checkout 或 node_modules，不会启动或停止共享 daemon。

## 构建与分发

在已准备好的 NMG checkout 中运行：

```text
npm run codex:package -- --output ./releases/codex
```

分发生成的 `.tgz` 或完整 `plugin/` 目录。归档先解压，再将其中 `package/` 目录作为
本地 marketplace 添加。包内有编译客户端、完整 Skill、hooks、清单及 marketplace 目录。
复制的 Skill 引用中，仓库 owner 链接指向 GitHub，操作参考仍保留本地。
`codex-plugin/` 源码目录是构建输入，安装时使用生成包。

## 安装

针对生成目录或解压后的归档目录：

```text
codex plugin marketplace add <plugin-directory>
codex plugin add nmg@nmg-local
```

在 Codex 配置 `[features]` 下启用 `hooks = true`，通过 `/hooks` 审阅并信任安装的定义。
脚本更新后需重新审阅，MCP 工具按 Codex 正常策略授权。插件不携带审批绕过或自动信任变更。

安装后使用新建／重新加载的 Codex 会话。当前测试引擎发现 hook 需要 `.codex-plugin`
兼容布局，生成包使用这一布局。关闭 hook 时普通工具仍可使用，自动上下文及 prompt 时协作需要 hook。

## 会话与生命周期

MCP 使用 Codex 原生传输元数据，hook 使用原生 session／turn 字段。
全局 `NMG_SESSION_ID`、`NMG_AGENT_ID` 不会合并 Codex 聊天。
新建／fork 的原生 ID 对应独立 AG，恢复相同 ID 时保持绑定。
原生 clear 建立新的 NMG 代次，旧代次调用被拒绝，新回合须经过 hook 准入。

`<NMG data>/codex-sessions/` 只保存当前代次及每个聊天最多 128 条准入回合作用域，
不保存记忆正文或凭据。Writer 租约、AG 状态及证据仍由 daemon 管理。
没有 hook 准入时，显式工具仍隔离会话，项目作用域保持未知，不从提示词猜测。

插件接入共享能力装配及 InformationView 预算。状态在可选召回前准备，
在 compact 会话／PostCompact hook 恢复。黑板在用户 prompt 和原生 Stop 边界批量投递。
Stop 接收批次后可续接一次，沿用 wake 开关、预算与冷却。回执在输出接收后覆盖已准入片段。
完全空闲的聊天等待下一个原生事件。Stop 报告处理状态 unknown，提出续接后报告 busy。

`nmg_remember action=feedback` 接收显式标签和被评价的 activeGraphId，
daemon 回报该标签是否能够训练对应暂存决策。自动答案重合属于独立诊断。
Stop 提供原生已完成回复，适配层每轮最多保留 32 个投影引用及陈述指纹。
声明 `versioned-answer-attribution` 的 daemon 核对所有权与当前内容版本，再计算重合。
中断轮次丢弃诊断引用。该诊断不标注真伪、任务成功或有用证据。

Bash hook 可能只提供 stdout，缺少退出状态时按结果未知观察。
结束时可通过有界 transcript 读取，核对相同原生调用和轮次，再记录一次最终状态。
严格检查已测试的 Codex 0.169 格式，未识别格式保持结果未知，不能触发成功提交提醒。
RPC 工作共用四秒 hook 期限，处于 Codex 五秒处理器超时内。
准备完成与最终供应商输入确认分别记录。

`NMG_DATA_DIR`、共用召回／显示设置和 `NMG_ENABLE_COORDINATION` 保持既有含义。
daemon 不可用或不兼容时，工具返回错误，hook 跳过可选上下文。
通过 NMG 正常 CLI 在适当时机启动／升级服务，插件不替换存活 owner。
