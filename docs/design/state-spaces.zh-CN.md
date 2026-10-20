# 统一 state 入口与状态空间

[English](state-spaces.md) · [共用术语](state-spaces.terms.yaml)

**Status:** current
**Updated:** 2026-10-15
**Related:** [接口决定](../decisions/implemented/2026-10-12-state-space-entry.zh-CN.md)

## 范围

AG 和 board 通过同一个 state 入口读写，但仍是不同状态空间。统一入口复用
原 owner、类型化视图与输出准备，不增加状态库、`StateView`、副本缓存或脚本执行器。
AG 变更针对当前 `working_state`，不是任意覆盖整个 AG。

## 接口与操作

```text
nmg state <read|write> <ag|board> [operation] [named options]
nmg_state(action="read"|"write", space="ag"|"board", operation?, ...)
```

`read` 未指定操作时默认为 `read`；`write` 必须指定空间内操作。操作集合与
参数校验由 [共享 state 接线](../../src/integration/state.ts) 和
[CLI 命令声明](../../src/cli/commands.ts)维护。未知空间、方向或操作拒绝，不改投另一空间。
AG 拒绝额外的黑板/寻址字段；宿主不能静默丢弃这些字段后执行写入。

`SESSION`、`TASK`、`AGENT` 须替换成实际身份。AG 调用要求已运行的兼容 resident
daemon，详见下文。board 写入会显式发布内容，不得泄露私有状态或秘密。
这些只是命令形式，不代表一次生产环境执行。

```text
nmg state write ag enable --session-id SESSION --reason "维护当前状态"
nmg state write ag replace --session-id SESSION --text "完整当前状态"
nmg state read ag --session-id SESSION
nmg state write ag disable --session-id SESSION
nmg state write board put --task-id TASK --agent AGENT --content "协作条目"
nmg state read board --task-id TASK --agent AGENT
```

AG 支持 `read/status` 和 `enable/disable/replace/clear`。board 保留领域读取、发现、
发布、订阅、租约、交付、独立裁定和关闭操作，不退化为通用对象的 `set`。
省略 board 的 `taskId` 使用共享 world 频道 `default`。

RPC `state` 是增量能力 `state-spaces`。返回保留 `action/space/operation`、原 owner
的 `result`，以及适用时的 `PreparedInformationOutput`；不是另一套状态视图。
不支持该能力的 daemon 明确拒绝，不静默回退成别的 RPC。

## 不同状态空间

| 空间    | 寻址与作用域                       | 状态和生命周期                                        | 写入 owner |
| ------- | ---------------------------------- | ----------------------------------------------------- | ---------- |
| `ag`    | 私有 session/frame；宿主绑定上下文 | 临时工作状态，受 AG 容量和 frame/session 生命周期约束 | AG runtime |
| `board` | 共享任务频道/条目；保留参与者归属  | TTL、租约和协作状态机，不是共享 AG 或语义记忆         | 黑板 owner |

统一入口不合并作用域、存储和权威。私有 AG 内容进入黑板必须是显式 board 写入，
不因读取、租约启用或地址转换自动发布。跨空间步骤有独立结果和失败边界，不承诺
跨 owner 原子事务，也不无条件重放非幂等的黑板操作。

领域条件由 [AG 写入契约](../decisions/implemented/2026-10-08-ag-working-state.zh-CN.md)和
[黑板治理](../decisions/implemented/2026-09-06-board-governance-addressing.zh-CN.md)拥有。
state 分派调用原 owner；它不授予越过拒绝条件的权限。

## AG writer 生命周期与 fencing

`state write ag enable` 显式获取有原因、有 TTL 的 session writer lease，复用现有
activation authority 和 AG binding owner，不建立第二授权库。`replace` 完整替换一个
正文；`clear` 有意丢弃正文；`disable` 或到期撤销写权，不删除最终状态。

宿主提供 session/requester，不把任意 frame、权限或 binding 暴露为模型参数。
客户端在首次传输前捕获启用 lease 的 session/AG/frame/generation binding，重试保持
原 fence。raw RPC 调用者须提供该捕获元数据；stale/foreign/missing binding 拒绝。
绑定是 fencing，不是认证。拒绝、秘密检测与容量检查保留旧值，不截断或驱逐成成功。

AG CLI 操作要求已运行的兼容 resident daemon，不能用一次性 CLI 模拟私有 session。
DSH state 传输要求 resident owner；失败不接管 daemon 生命周期、不改走一次性 CLI，
也不自动重放领域拒绝。缺失 AG 从仓库或明确共享任务证据重建，不从展示缓存恢复。

## 现有视图与输入边界

```text
read → owner 准入数据/现有领域投影 → InformationView → prepareInformationOutput
write → 原 owner 的领域操作 → 短确认或同一视图体系准备的结果
```

[`InformationView`](../../src/core/information-view.ts)保留来源身份；AG/board 仍是写入空间，
召回 memory 与独立 workspace 是呈现来源，不因此成为新状态空间或 AG 权威。
[共享输出契约](../decisions/implemented/2026-10-07-shared-information-output.zh-CN.md)继续拥有
必要标签、字符预算和整项遗漏；接入不解析旧渲染字符串，不伪造写入后的状态正文。
AG 读取使用已有 snapshot 投影；`status` 读取 writer 元数据，不搜索历史。

Pi 的 widget 与 `/nmg state` 读取原 owner 的 snapshot，`nmg_state` AG 写操作刷新
视图；`/nmg state on|off` 只控制预览显示。状态仅在每用户回合的持久化
`nmg-context` 消息内携带一次，不注册逐次推理注入或成功写入去重。
过时/外来 snapshot 不覆盖当前展示。

呈现与实际模型输入的边界由既有输出和
[状态携带契约](../decisions/implemented/2026-10-08-ag-working-state-input.zh-CN.md)负责。
展示、短确认和携带不是披露 ledger 写入、事实支持、协作验收或 provider-send receipt。
Pi 最终 provider 输入确认仍 unsupported。

## 统一上下文信息项

新增 state 内容复用同一个 `InformationView` 协议；AG、board 是来源域，不是另一套
视图类型或状态库。`purpose` 是呈现职责：当前状态、任务材料、推理暂存、行动提示、
运行诊断。来源身份与用途是不同维度，Task 组合不是此协议的前置条件。

Pi 的 `nmg-context` 使用信息项列表，不解析旧标签或渲染行。一个候选、一条工具观察、
一条黑板投影、一个提醒分别选取；完整 `working_state` 和自洽 workspace checkpoint
保持整项。召回候选保留 preview 声明、检索降级条件与引用需要的 activeGraphId。
控制提醒没有事实权威；workspace 保留独立来源与暂存声明，不假装是 AG 数据。

原 owner 负责准入、作用域和生命周期。自动上下文只投影本 session/frame 的数据；
工具观察和黑板读取投影只自动延续到下一用户回合。无回合元数据的历史投影不自动
补成当前材料，显式读取仍可查看。历史黑板读取不自动复制到 AG；普通读取仅将 open
条目暂存，不改变原结果、delivery 记账或黑板状态机。语义相关性仍由 Agent 判断，
需持续保留的进展和阻塞由 Agent 写入工作状态，不靠关键词猜测任务或错误已恢复。

上下文准备复用 `prepareInformationOutput`：职责分组、正文、必要标签、分隔符、根标签
和遗漏通知共享 16,000 UTF-16 单元总预算。优先容纳完整当前状态和 owner 有界的压缩
恢复 checkpoint，再容纳当前诊断、任务材料与行动提示。普通推理项不挤掉已消费的恢复
checkpoint；同类按稳定顺序选取。超限信息项整项遗漏，不改写或截断；空组不输出。
遗漏说明优先从末尾可选项腾空间，不移除完整状态、恢复 checkpoint 或诊断；小预算
被保护项占满时，遗漏数仍通过元数据保留。
结构化 `views` 是输入快照，`included` 才是准备后纳入的来源，`omitted` 保留遗漏信息。
普通工具沿用平铺呈现和原预算，协议与源身份不变。准备结果不确认 provider 发送，
不提交 disclosure ledger；既有会话历史不因新选取规则删除。此输出预算不代表完整的
多维 AG 构建预算。

## 模型入口与兼容

Pi、MCP、DSH 注册 `nmg_state`，不注册独立 `nmg_board`；模型 Lab schema/执行入口
排除日常 `working_state`，其他实验能力保留。`NMG_ENABLE_COORDINATION` 的 false-like
值拒绝 board 操作并关闭 adapter wake polling，不隐藏或关闭 AG state。
唤醒和 delivery bookkeeping 继续走黑板 owner，不成为另一个模型操作入口。

旧 `taskBoard` RPC、`nmg board` CLI 和 Lab working-state RPC/CLI 保留兼容与管理用途。
兼容入口不放宽领域权限；normal state 与旧路径访问同一 owner，不复制业务逻辑。
接口不绑定 Pi/codemode，不引入管道、任意代码执行或隐式模型调用。

## 验证边界

契约测试覆盖空间隔离、方向/字段拒绝、binding/容量拒绝、原有视图来源与短确认、
CLI 接线及模型注册。Pi/MCP 隔离协议整合与 DSH 真实 host contribution 在模拟 Cordis
服务上的隔离 HTTP 测试，分别约束各自接线；后者不证明真实 DSH GUI 已启动。
完整验证、部署和用户可见性分别归因，不以文档检查代替运行时证据。
工具名减少不证明 token、模型连续性或自然遵循收益。
