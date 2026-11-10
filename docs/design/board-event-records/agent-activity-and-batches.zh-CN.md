# Agent 活动与回复批次

[English](agent-activity-and-batches.md) · [使用的术语](agent-activity-and-batches.terms.yaml)

**Authority:** [黑板事件记录](../board-event-records.zh-CN.md)。

## 在线身份与原生会话

黑板选择收件人、维护订阅并保存待送通知，InformationView 准备带预算的输出。
Harness 适配器将选中的 Agent／会话绑定到原生入队或恢复操作，并记录接收结果。
适配器进程的存活由宿主诊断表达，Agent 发现名册面向具有实际会话端点的协作参与者。

系统级 `taskBoard` 操作 `registerAgent`、`heartbeat`、`unregisterAgent` 维护在线状态。
退出立即从在线发现结果中撤下身份，同时保留名称、状态说明、工作归属、订阅和历史。
退出后的注册保持离线，迟到心跳不能重新激活。再次注册会恢复在线。
进程退出时若未成功撤下身份，则沿用既有心跳过期边界。

注册可携带 `presenceToken`，表达不透明的注册代次。心跳与退出须匹配该代次，
省略 token 对应旧式注册。这使旧端点的回调无法撤下同一身份的新注册。
token 是协作版本检查，身份与授权沿用已有边界。
采用该生命周期的客户端在传输前检查 `board-agent-presence` 能力。

DSH 将工具、订阅、处理报告与收据绑定到各原生 Agent 的身份和会话。
身份持久化显式使用原生锚点，使同一宿主进程中的多个 Agent 保持独立。
具名工具参数在 `rename` 时提供新显示名，普通操作从绑定身份读取当前名称。
state 操作要求原生 Agent 上下文。每个端点的在线状态写入按序执行，
退出失败时，存活的适配器保留重试资格。

原生会话销毁、从宿主活动会话列表消失及适配器卸载时，撤下对应端点。
持久化的 continuable 子会话在活动父会话提供恢复操作时，可以自己的身份参与发现。
空宿主不为轮询启动 daemon。适配器读取各接收者自己的订阅与收件箱，
将共享准备器产出的片段提交给对应原生端点。

DSH 激活时撤下旧项目注册 `dsh:<project>`。历史消息和事件角色保留原作者，
旧项目订阅仍可按原身份读取。将旧工作或订阅分配给具体原生 Agent，需要显式的领域操作。

## 会话处理状态

黑板为每个 Agent／会话组合提供共享处理状态，通过 `nmg_state space=board`
的 `agentActivity` 读取与写入。显式指定会话，使同一 Agent 的忙碌会话和可用会话可以并存。
任务派生的 `agentStatus.activity` 继续表达已登记工作。发现列表通过带会话来源标签的
InformationView，并列呈现处理报告、任务与公开状态说明。

报告使用 `state=busy|idle|unknown` 和 `source=agent|harness`。
Agent 可以独立声明忙碌，Harness 提交原生观测。两类来源各自拥有报告、版本和过期时间。
任一有效报告为 busy，汇总状态就是 busy。没有 busy 且存在有效 idle 报告时为 idle。
其余情况为 unknown，包括报告全部过期的情况。

能力取所有有效来源声明的并集，可表达 `batch-enqueue`、`processing-observation`、
`idle-boundary`、`resume`、`stdout-context`，以及 Agent 提供的协作机制。
各 Harness 贡献自己支持的机制。即使缺少原生支持，黑板扩充的语义仍可通过 Agent 报告发挥作用。
能力名称描述声明的支持程度，具体宿主接收结果提供投递证据。

写入需要 `activity.state`，可选 `source`、`capabilities`、`ttlSeconds`、`expectedVersion`。
默认来源为 `agent`。省略 capabilities 保留该来源仍有效的能力，传入空数组则清空。
每次成功写入产生新版本。指定 expectedVersion 时，必须与该来源的有效报告版本一致，否则失败。
观测或声明持续有效时续租，解除忙碌时报告 idle。租约到期后，普通读取即可反映写入者失联后的未知状态。

```json
{"space":"board","action":"write","operation":"agentActivity","agentId":"reviewer","sessionId":"session-1","activity":{"state":"busy","capabilities":["manual-coordination"]}}
{"space":"board","action":"read","operation":"agentActivity","agentId":"reviewer","sessionId":"session-1"}
{"space":"board","action":"write","operation":"agentActivity","agentId":"reviewer","sessionId":"session-1","activity":{"state":"idle"}}
```

声明沿用黑板的协作身份边界，调用者选择自己的报告来源。运行时授权和强制约束由宿主负责。
unknown 显式表示缺少观测。自动批次投递遇到 busy 时暂缓，遇到 idle 或 unknown 时可通过适配器已有的输出机制推进。

## 待送回复与批次准备

频道讨论保留逐条关联来源的待送通知，事件更新提醒继续按事件修订合并。
订阅、直投对象、退出、自身回声、有效认领、串行交接和送达资格均在待送查询分页前过滤。
已送达条目可继续被读取，同时让后续待送条目进入下一页。
历史上已因合并而退役的通知保留其记录状态，来源仍可通过历史发现。

共享准备器先按创建时间、序号和 ID 排列各事件／频道范围内的消息，再轮转从每个范围取一条。
有界传输页交给一次 InformationView 准备，每个纳入的来源保留通知 ID、频道和作者。
必要标签及包装计入共享渲染字符预算。因预算省略的来源继续待送。
超出传输页的来源在空间允许时提供续读诊断。
批次大小由已到达回复和预算决定，无须等待全部参与者回复。

批次为一次投递尝试固定来源身份和渲染文本，后到消息留给后续批次。
适配器进程内以会话 singleflight 协调重叠轮询。
准备前及返回待投递输出前各检查一次忙碌状态。忙碌会话保留待送通知，其他接收者继续推进。

关联事件的通知在准备时读取当前事件阶段、阶段修订和状态，投递前再次检查选中的事件。
发生变化则拒绝本次准备，等待重试。输出携带当前阶段快照，并标记消息自身的阶段来源为未知。
阶段协商由[阶段契约](phase-agreement.zh-CN.md)维护。

## 宿主接收与收据

适配器通过支持的输出机制提交准备好的完整片段。只有实际纳入该片段的来源在成功接收后获得送达收据，
每个接收者各自记录。输出被拒时，全部来源保留重试资格，不消耗唤醒预算。
一次接收成功的批次消耗一个配置的唤醒单位。

声明 `board-wake-batches` 的 daemon 接受 `recordDelivery.entryIds`，在一次 Store 事务中提交整组收据。
事务失败则整组仍可重试。单条 entryId 形式继续支持，旧版收据传输在接收成功后逐条写入。
跨宿主与 daemon 的崩溃边界采用至少一次重试语义。
收据记录传输接收，已读确认、任务认领和实际行动继续各自表达。

Pi 和 OpenCode 提供原生处理状态观测。DSH 观测可用的父会话及可继续子会话状态，
通过原生消息或恢复操作接收批次。网页历史保留已送来源用于显示，原生批次提交一次。
WorkBuddy 报告原生处理状态 unknown，并提供 stdout 上下文。
只准备文本时不写收据，其 CLI 在 stdout 回调成功后确认送达。

处理状态检查、阶段检查与原生入队分别发生，这个顺序缩小竞态窗口。
跨进程预留和在途工具隔离仍属于额外协作机制。
实现 owner 为[活动解析](../../../src/core/agent-activity.ts)、
[持久化报告](../../../src/core/store/coordination.ts)及
[共享批次投递](../../../src/integration/board-wake-batch.ts)。
