# Magpie 的 NMG 插件

[English](README.md)

插件提供共享 NMG 工具、网关上下文和管理页面，目标宿主为 Magpie 0.1.4338 与 Bun。
使用前启动兼容的 NMG daemon。能力声明位于
`src/integration/adapter-manifests/magpie.json`，选项由 `options.schema.json` 校验。

## 构建与安装

在仓库目录执行以下命令。

```text
npm ci
npm run magpie:package -- --output releases/magpie
magpie plugin add ./releases/magpie/nmg
```

可分发生成的 `nmg` 目录或 npm 归档。使用归档时，先解压，把解出的
`package` 目录改名为 `nmg`，再执行 `magpie plugin add ./nmg`。
Magpie 使用目录名确定工具前缀和插件选项。归档已包含运行依赖，
插件连接所配置 NMG 数据目录下已运行的 daemon。

Magpie 通过 Library 和插件 MCP 服务提供工具，使用 Library 选择接收工具的客户端。
网关 hook 需要客户端模型流量经过 Magpie。管理页面出现在 Magpie 导航中。

## 会话与组合

带 agent 和原生 session 的 `local`／`magpie-key` 请求会获得不透明 `NMG_BINDING`。
调用插件工具时传入该句柄。独立使用工具时，先调用一次 `nmg_session action=open`，
在该聊天中保留返回句柄，其他聊天分别创建会话。句柄认证 daemon 管理的会话范围。

Magpie 0.1.4338 给插件工具的 `sessionID` 为空，插件通过有效期 24 小时的密封句柄维持隔离。
缺少原生身份、远程来源及仅有父会话 ID 的子 Agent 请求跳过网关准备。
显式工具会话仍可使用。

`nativeCapabilities` 选项按 Magpie agent 名称选择已由原生适配器承载的生命周期能力，
通过 Magpie 的插件选项配置。工具可通过 Library 独立选择。
状态正文、证据预算和黑板批次复用共享 InformationView。
成功回复且被接受的请求包含准备内容后，才记录黑板投递和答案诊断。
外部工具的报告结果保留未知执行状态。

## 管理页面

页面显示服务范围内的数量、持久自动／主动搜索尝试，以及分别标注来源的网关用量。
向量用量按服务商和请求的模型汇总 daemon 最近 30 个 UTC 日期的 HTTP 请求，
包括成功响应耗时、失败数和取消数。
未知指标保持未知。向量设置先创建候选配置，连接测试和索引构建均为显式动作，
可能调用所选向量服务。候选就绪且明确选择托管设置后才能激活。
准备期间当前索引持续可用。Key 保存在服务管理的设置文件中，创建时限制为所有者权限，
读取返回脱敏状态。重启恢复已保存的设置，取消或中断的构建可根据持久待建向量重新开始。

页面服务只监听 loopback，默认端口 3487，可通过 `port` 调整。
管理请求受进程级令牌保护。管理页面要求 daemon 支持 `operator` 方法，
既有 daemon 继续提供其支持的工具。
