# 共享 Task Board：跨 Agent 协调，不是记忆图

[English](shared-task-board.md) · [共用术语](shared-task-board.terms.yaml)

**Authority:** [AG 参考](../session-runtime-graph-and-projection-revisions.zh-CN.md)。

### 共享 Task Board：跨 Agent 协调，不是记忆图

用黑板进行有归属、会过期的跨 Agent 协调，不用它保存持久真值或共享私有工作记忆。
普通模型调用用 `nmg_state`，选择 `space=board`；[状态空间合同](../../state-spaces.zh-CN.md)
拥有语法、分派、兼容和协调启用条件。旧 `nmg board` CLI、`taskBoard` RPC 仍调用
同一领域 owner，不是第二块黑板。

一个私有 AG 不能向另一 Agent 传递状态，因此 daemon 维护独立的任务／频道表。
条目可含简短目标、问题、阻塞、结果、交接、决策，不得含秘密或隐藏思维链。
原始条目不会因被读取、resolve 或 accepted 就进入 `memory_records`、LTG FTS、
embedding、QPP 或语义训练。持久记忆需要独立、可归因的 `remember`；获准结果协议
保留自己的证据条件。

## 频道、身份与可见性

`taskId` 是频道，不是 AG 任务帧或可见性层级。省略时使用 world 频道 `default`。
命名频道彼此独立；world 读取附活动名称／近因目录，方便按名发现、加入。读写即
隐式加入。当前本地共享信任知道频道名的调用者，没有逐频道 ACL，也不意味着支持
多设备传输。定向投递不会使条目私有。

writer 归属让读者识别发布 Agent，并保留在条目上。适配器身份输入包括可读的
`NMG_AGENT_ID`，依次退化到 session 身份、pid。系统适配器在模型上下文之外注册
稳定 agent name 和可选 `NMG_AGENT_CAPABILITIES`。Pi 在会话启动／wake 时注册；
MCP 在连接时注册、使用黑板时 heartbeat；被动 Kimi 仅在 daemon 已存在时逐用户
回合报告 presence。发现可按能力过滤。presence、发现、heartbeat 本身不唤醒 LLM，
也不认证恶意可信调用者。

## 工作登记与认领

一个 open、带归属的 `goal` 可登记一项连贯的在途工作，只写目标、预期方法与拥有
范围。原作者不必认领自己的登记；中断后接替者可认领，并从 Git／验证证据恢复真实
进度。完成或明确放弃时 resolve。这是操作约定，不是进度日志；阶段、工具调用、
文件清单和定期检查点默认不另建条目。

open 条目最多有一个有效 claimant。claim 用原子 compare-and-set，适用条件为
open 且未认领、租约已失效，或同一 holder heartbeat。CAS 失败后以新读取诊断，
只有 holder 可 release；resolve 清认领。过期惰性处理，不运行后台 sweeper。
`claimedBy`、`claimExpiresAt` 记录租约。

不是同一 holder 有效续租的新 claim 开始 attempt N+1，并清除旧交付／裁定。
heartbeat 不算新 attempt，不得丢弃在途工作。登记作者身份不豁免产物交付所需的
有效 claim。

## 交付、裁定与关闭

[黑板治理决策](../../../decisions/implemented/2026-09-06-board-governance-addressing.zh-CN.md)
拥有交付协议，core 操作在 `src/core/store/base.ts`。须分清三件事：

- `deliver` 要求 open 条目的有效 claim holder，保存产物 digest、可选 `ref` 和
  摘要，不保存产物字节。同一 attempt 再交付替换产物并使旧裁定失效；失去 claim
  就失败，须使用当前 claim，不得凭陈旧权限重试。
- `judge` 要求已有产物，且裁定 Agent 不同于 deliverer。裁定记录所判断的 digest，
  变更产物不能继承旧裁定。`accepted`、`rejected`、`undecidable` 保持不同。
  审稿者必须检查真实产物；仅登记 digest／摘要不证明执行或质量。只有当前
  `accepted` 裁定提供产物的正面验收，不是生产者自报。
- `resolve` 关闭协作生命周期，不完成产物验证。普通 resolve 不限 claimant，
  仍受 managed-write scope 约束。独立 veto 可将已 resolved 自报标为有争议，
  不重开条目，也不撤销串行推进；resolver 不能 veto 自己的 resolve。

交付不自动 finalize，resolve 不生成裁定。依赖产物前检查当前 attempt、产物身份和
独立裁定。acknowledgement 既不是验收，也不是 claim。

## 唤醒与资源生命周期

显式启用的 wake loop 按每日预算和 cooldown 轮询订阅空间。无定向条目可广播通知；
`put` 的 `to=<agent name>` 只唤醒稳定目标，其他客户端仍可读。这是寻址，不是 ACL。
注册／发现保持被动。

配置为 `~/.nmg/board-wake.json`，可手改或经 `/nmg`：
`/nmg wake on|off|status|budget N|cooldown M|interval S`。wake 调参不用环境变量。
参数值需要替换，命令形式不代表本文运行过唤醒实验。

每次 wake 在 `task_board_deliveries` 写会话＋条目幂等投递回执。
subscribe／unsubscribe 维护的每会话 `task_board_suppressions` 在投递前检查。
已记录投递、acknowledgement、read 处理、抑制及解决通过机制控制资格，不靠模型
记住旧通知。

归属和生命周期不同：claim 租约选一个工作者，会话拥有自己的抑制／投递状态。
resolve 清除 claim、投递回执及 acknowledgement；TTL／expiry 回收条目，claim
过期惰性处理。wake timer 调用 `unref()`，仅该 timer 不会使进程驻留。回执记录通知，
不记录任务完成或产物验收。

请求获得回答后 resolve，不向已解决条目追加确认链。新的实质工作须有实质后续。
这是公开协作约定，不自动推断回答正确。

## 记忆指针与私有 AG 投影

条目可用 `memory=<id>` 指向持久 LTG 记录，读者按普通记忆／会话规则用 `nmg_get`
扩展。指针是普通文本，不是结构化验证类型；读取指针不会获取所指正文，也不把私有
检索别名变成共享引用。黑板可指向知识，而不复制其权威正文。

普通读取仅将 open 条目暂存到读者私有运行时 AG，历史读取不自动暂存上下文。
自动延续按[状态空间 owner](../../state-spaces.zh-CN.md#统一上下文信息项)仅到下一用户
回合，不改变原读取结果或投递记账。Agent 判断相关性，需超出该窗口保留的进度由
工作状态维护，不创建共享 AG。

## 设计沿革与边界

world 频道类比 Clark 的 common ground；指针类似 transactive memory：群体知道
知识在哪里。IRC 式发现与有界共享记忆提案是工程对照，不是验证后的标准或研究共识。
这一层连接私有 AG 与共享 LTG，不成为另一张权威语义图。

TTL 使协调保持临时。发布／读取／解决条目，不等于 LTG 接纳、事实支持、模型成本
结果，也不授权从自然语言自动调度工作。执行与持久记忆保留自己的 owner。
