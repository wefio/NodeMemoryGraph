# 在 DSH 与 OpenCode 中使用 NMG

[English](native-adapters.md) · [术语](native-adapters.terms.yaml)

安装、加载、使用或排查仓库中的 DSH／OpenCode 原生适配器时阅读本文。开发适配器时读
[开发合同](harness-adapters.zh-CN.md)。[能力矩阵](../../../docs/design/harness-capability-matrix.zh-CN.md)
区分源码接线与运行验证。

## 选择连接方式

保留 NMG checkout，使用版本兼容的插件与 daemon。新 checkout 先在仓库根目录执行
`npm ci` 和 `npm run build`，再配置宿主。安装 Skill 只提供操作指引，
不会注册工具或自动上下文 hook；这些连接由原生插件提供。

已经连接 `nmg_search`、`nmg_get`、`nmg_remember` 和 `nmg_state` 时直接使用。
CLI 是 shell 替代路径，不需要经两条路径重复同一操作，也不必为了复制已有原生工具
再安装一套 MCP。不同工具连接的会话身份与投影句柄不能互换。

首次安装或调用失败时检查 `nmg daemon status --json`。复用运行中且兼容的 owner。
未运行时按[daemon 操作](operations.zh-CN.md)启动并记录所有权。运行中的不兼容 owner
需要在安全时机协调升级，构建插件不会升级它。不要为了检查安装而停止或替换共享 daemon。
具体功能还可能要求声明相应能力，例如 DSH 的 `board-agent-presence`。

## 日常使用

使用宿主绑定的工具，不在模型参数中提供 session ID、Agent ID 或 writer binding；
这些值由适配器提供。

| 需要 | 操作与结果 |
| --- | --- |
| 找回既有决策 | 使用当前相关召回头行，或用聚焦查询调用 `nmg_search`。头行是候选，不是精确证据。 |
| 查看证据 | 经同一会话连接调用 `nmg_get`，提供选定记忆 ID，并在可用时提供对应 `activeGraphId`。 |
| 保存持久结论 | 通过 `nmg_remember` 提供可归因证据；更新、遗忘和反馈见[写入参考](writes.zh-CN.md)。 |
| 维护当前进度 | 启用 AG writer，再经 `nmg_state` 替换完整当前文本。临时进度不会因此变成持久记忆。 |
| 协调 Agent | 使用 `nmg_state space=board`；发现、订阅、批量读取与回复见[board 操作](board.zh-CN.md)。 |

维护状态时，依次使用以下参数对象调用 `nmg_state`：

```json
{"space":"ag","action":"write","operation":"enable","reason":"继续当前任务"}
```

```json
{"space":"ag","action":"write","operation":"replace","text":"目标：完成适配器。\n已验证：原生工具可以运行。\n下一步：验证剩余生命周期边界。"}
```

`updated` 和 `unchanged` 是正常的简短回执。下一个准入用户回合将当前完整状态与召回
分别准备，所以可选召回为空或失败时仍可承载已准入状态。DSH 走原生上下文通道，
OpenCode 走 prompt／context hook。写入回执本身不确认最终模型输入。不要为了迫使状态
进入上下文，把它再复制成另一条召回消息或保存成持久事实。

只有状态改变时才更新。明确丢弃时用 `operation=clear`；结束 writer 租约但保留可读文本
时用 `operation=disable`。租约过期、重启恢复与内容上限见
[日常工作状态](optional-capabilities.zh-CN.md#日常工作状态)。租约缺失时需要显式重新启用，
不能伪造 fence 或绕到 Lab 写入。

适配器会观察选定工具结果并提供弱 commit 提醒。答案重合归因是诊断信号。
工具成功、提醒和完成回复都不能确认记忆中的声明，也不足以提交正向反馈。

## DeepSeek Harness

使用 `dsh/dsh-nmg/` 双面宿主包。宿主侧注册工具与上下文 hook，浏览器侧渲染工具卡片。
历史 `dsh/nmg-plugin.mjs` preset 不是另一个当前安装目标。

1. 在 `<checkout>/dsh/dsh-nmg` 中构建：

   ```text
   pnpm install --frozen-lockfile
   pnpm run build
   ```

2. 首次安装到 web profile 时注册本地包：

   ```text
   dsh plugin --profile web add "link:<checkout>/dsh/dsh-nmg"
   ```

3. 在协调后的 DSH 重启或受支持的安全加载边界加载构建结果。
   `lib/index.js` 与 `lib/client.js` 必须存在。只构建不会更新运行中的宿主。
   Profile／构建细节由[包 README](../../../dsh/dsh-nmg/README.md)负责。

当前包暴露 `nmg_search`、`nmg_get`、`nmg_remember`、`nmg_state`、可选 Lab 和 daemon
健康检查。召回在 inbox 到达时启动，请求准入等待有界准备，原生循环在提交内容前刷新
`systemPrompt.context`。同一代次只准备一次状态，新 inbox 代次排除上一代自动片段。

最终 `tools/result` 接共享 AG 观察和弱 commit 提醒。已提交答案只在完成的 `turn/end`
上归因，取消与重复结束不产生归因。黑板发现表示实际 Agent 会话，空适配器宿主不是
可接单的 Agent。

## OpenCode v2

使用持久 NMG checkout 中的 `opencode-plugin/`。插件直接导出 `index.ts`，没有单独的
适配器构建步骤。按正常流程准备 checkout 与常驻 daemon，再配置项目或用户
`opencode.json`：

```json
{"plugins":["C:/path/to/NodeMemoryGraph/opencode-plugin"]}
```

也支持把目录链接到 `.opencode/plugins/`，选择一种注册方式。在安全会话边界按宿主支持
的流程启动新 OpenCode 服务。模块缓存意味着修改 checkout 不会更新已有进程。
插件不启动或停止 daemon。详见[适配器 README](../../../opencode-plugin/README.md)。

Code Mode 目录使用显式 `nmg_` 名称，例如：

```javascript
const result = await tools.nmg_search({ query: "Atlas 决定使用哪个数据库？" });
return result;
```

原生会话查询在首回合召回前解析项目作用域，插件 location 是回退，`NMG_PROJECT_DIR`
显式覆盖。查询与回退都没有目录时，召回缺少项目作用域。Prompt 准备共用 1.5 秒总预算，
迟到查询不能更新当前作用域。重建请求复用已准备片段，新 prompt、压缩和执行完成会按
各自边界使旧准备失效。已验证手动原生压缩后新 prompt 携带当前状态；这不覆盖全部自动
或中断时序。

## 检查激活与排查故障

先做聚焦的 `nmg_search`，再对相关结果做一次 `nmg_get`。搜索为空是合法结果，不能据此
判断插件未加载。检查状态承载时，使用一次性会话写入无敏感内容的完整状态，再发送下一条
prompt。模型复述其中内容不等于最终发送确认。

| 表现 | 下一步 |
| --- | --- |
| 工具缺失 | 检查选定 profile／配置、包路径与新宿主激活。路径出现在配置里不等于有 setup 回执。 |
| DSH 无法加载 `lib/index.js` | 构建源码包，再协调加载该构建。不要编辑生成的部署副本。 |
| OpenCode 只显示短名称或旧行为 | 确认新服务只加载一次目标 checkout。不要依赖 `options.namespace` 加前缀。 |
| 状态返回 `updated`，后续却缺失 | 检查原生会话连接、writer 租约和下一回合边界。经 `nmg_state` 读取当前 AG，不换用另一会话的图。 |
| 作用域错误 | 重试搜索前，检查原生会话 location 与意外的 `NMG_PROJECT_DIR` 覆盖。 |
| 能力不支持或 owner 不兼容 | 遵守返回的兼容边界，不删除字段把请求改成别的操作求通过。 |

受控联调使用保留的[原生探测](../../../docs/experiments/runtime/native-plugin-capabilities-2026-11-12.zh-CN.md#复现)，
指定实际安装路径并带 `--exercise-hooks`。它使用私有 NMG 存储与本地模拟模型。
保持验证隔离，不通过重启共享服务或向供应商发送真实对话来测试。没有激活过程的 API-only
查询不足以证明插件 hook 不受支持。

已安装 DSH 核心服务和实际 OpenCode 2.0.32 宿主有范围明确的运行证据。真实空闲唤醒、
fork／reset／重连代次和桌面加载保留独立验证门槛。具体范围以核实记录为准，不能把
fixture 通过当成完整宿主覆盖。

## 与 Magpie 组合

Magpie 在[集成设计](../../../docs/design/unified-architecture/magpie-integration.zh-CN.md)中保持
完整独立 NMG 插件目标。本文不提供尚未交付绑定的安装命令。DSH／OpenCode 的原生状态、
记忆工具和观察可独立于该绑定运行。经过验证的组合按操作选择一个效果所有者，并接续
获准的会话／披露上下文。名称相同不表示会话已关联，不要在缺少受支持交接时再启用
第二个自动注入器。GUI、token 用量与追踪属于独立增强。
