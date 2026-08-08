# NMG agent 侧使用反馈（2026-08-08）

来源：Pi harness 下一个真实使用 NMG 的 agent 的一手反馈。背景：在既有会话
（2026-08-06 反馈之后）里做 pi-lsp 扩展改造——跨多轮、有明确环境状态、可
持续数小时的连续任务。全程多次 `nmg_remember`，直到用户反问"记忆光记了，
有用过吗"之前，**一次都没有 `nmg_search`/`nmg_get`**。最后被点醒后取回，
确实翻出 3 条过期记录。以下是这次暴露的问题，与 08-06 那份不同，这份侧重
**"写得出但取不回"**。

## 设计审查结论

本文件记录的是使用现象和改进假设，不直接构成 NMG 需求。以下意见以
`design.md` 的 STG/LTG/AG、三层召回和 Lite 三工具边界为准：

- **接受实现缺口：** Pi 的自动召回只有最新 prompt，没有设计公式中的
  `task_t`；短续接消息因而无法激活已有任务节点。
- **不接受强制手动搜索：** “进入已有领域必须先 `nmg_search`”会违背“多数轮次
  不加载动态记忆”和渐进披露原则。应由自动召回层先做有预算的任务相关投影，
  只有目录不足时才建议 Agent 主动搜索。
- **不接受新增一步式工具：** Lite 保持 `search/get/remember` 三工具。header 足够时
  不必 `get`；需要原文时才展开。`activeGraphId` 是使用归因信息，不是读取前置条件。
- **stateKey 是接口指引缺陷：** `stateKey` 实际表示一个可替换属性，但旧工具说明
  只说“stable key”，没有向使用者说明它不是主题或节点分组标签。使用者把
  `pi-lsp-env` 当作相关记录的归组键是合理推断；修复责任在 schema、手册和示例。
  setup、工具清单和 patch 约束不能仅因都属于 pi-lsp 就互相覆盖。
- **不接受因 summary 重复而降低 LTG：** summary 是易失的会话表示，LTG 是跨会话
  持久状态。AG/适配器应抑制当前上下文已覆盖的重复注入，而不是改变长期 residence。
- **部分接受复核：** 只复核本任务实际依赖过、且具有易变性的 state/constraint；
  不在每次任务切换或会话结束时对全库进行 LLM 对账。
- **缓存顺序约束：** 稳定的 base prompt、policy 和工具 schema 应保持稳定前缀，
  每轮变化的 automatic recall/status/nudge 放在消息上下文尾部。Pi 将工具 schema
  作为独立 API `tools` 字段发送，NMG 不把 schema 复制进动态 prompt，也不假设
  JSON 字段的表面排列能改变供应商的 prefix-cache 语义。

## 1. 重存储、轻取用：取用的激励和触发器都没设计进去（最重要）

> **设计意见：部分接受。** 零手动搜索本身不是失败，自动召回本应承担常见路径。
> 缺陷是 Pi 未把当前任务状态送入自动层，而不是 Agent 缺少强制搜索纪律。

现象/证据：本会话累计写入 6+ 条 `pi-lsp-env` 记录（setup / vendored /
toggle / navigation / 11-tools / patch-constraint / workspace-symbol-mechanism），
但过程中从未主动取用；若不是用户点名，整个会话零取回。取回行为几乎完全由
用户催促触发。

根因（设计层，不是 agent 懒）：

- 现有 policy 写的是 "decide which candidates matter"——给了 agent **忽略候选
  的许可**，却没有"进入已知领域必须先查"的硬性要求。许可 ≠ 触发。
- 没有任何**首次取用**的触发器：自动召回只在会话开局触发一次且按单条消息
  字面匹配（见第 2 点），任务中途没有任何"这个话题你有 N 条记录"的提示。
- 取用是两步（`nmg_search` → `nmg_get` 带 activeGraphId），在快速任务流里
  感知成本高于收益；而写入是一步、且每次 milestone 都有明确动机，所以行为
  单向倾斜。

建议：

- policy 把"忽略候选"从**一次性许可**改成**持续性警觉**，并补一条首次触发
  硬钩子（措辞修订见文末"附 B"）：进入你有 state/constraint 记录的领域时，
  动手前先 `nmg_search` 一次。
- 会话内周期性复查要有具体时机：任务切换、状态变更前、每几轮——而不是
  模糊的"时不时看看"。
- 提供一步取用接口："关于 X 我已知什么"，一次返回去重后的可执行结论，
  省掉 search→get 两步和 activeGraphId 摩擦。

## 2. 自动召回只匹配单条消息，且只在开局触发一次

> **设计意见：接受“缺少任务上下文”，修正“只在开局”。** Pi 的 hook 每个
> `before_agent_start` 都会运行，但旧触发器只接受显式回忆词，所以实际行为近似
> 只在用户提醒时工作。修复应使用紧凑、会话级 task context，不拼接整段历史。

现象/证据：压缩后会话开局注入的 `<nmg_automatic_recall>` 返回
"No matching NMG memory found"——而库里明明有 6 条 pi-lsp 记录。因为召回
匹配的是当前这条用户消息的字面文本（"我 reload 了，你试试"），相关记忆
挂在**任务/主题**（pi-lsp 环境状态）上，不在消息文本里。

根因：召回触发条件 = 最新一条消息，而非最近几轮的**任务上下文**；并且只在
会话边界触发一次，任务中途不重新评估。

建议：

- 召回基于最近 N 轮的任务上下文（含系统摘要里出现的主题），而不是单条消息。
- 当对话明显落在某个已存 node 的话题上时，主动提示"你有 N 条 `pi-lsp-env`
  相关记录"，即使没有精确字面命中。

## 3. 写侧不合并：同一 stateKey 堆了 6 条近重复

> **设计意见：不接受按节点自动合并。** 核心已经对相同 `stateKey + scope` 的
> `state` 自动 supersede。若六条仍并存，应先核对 memory type、scope 和 key；而且
> 本节列出的 setup/tools/constraint 很可能是不同属性；旧接口没有把这一点表达
> 清楚，导致它们合理但危险地共用了一个 key。搜索也不能默认每节点只留一条，
> 否则会丢失互补证据。

现象/证据：一次 `nmg_search "pi-lsp"` 返回 6 条高度重叠的记录
（setup / vendored / toggle / navigation / 11-tools / patch-constraint），
必须逐条比对才能判断"哪条是当前事实"。取用成本一半花在去重上。

根因：同一 node/stateKey 的重复写入**只增不并**；写入时也不做 supersede
标记，旧记录与新记录平级共存。08-06 反馈第 4 点（nodeName 即兴命名导致图
碎片化）的镜像问题：这里 nodeName 稳定，但**同节点内版本堆积**。

建议：

- 写侧对同一 node/stateKey 做**收敛/版本化**：新写入取代或标记旧记录
  （superseded），而不是无限堆积。
- `nmg_search` 返回时对同节点去重，默认只露最新版本，历史折叠可查。

## 4. 会话内与 summary 冗余：取用的边际价值 ≈ 0

> **设计意见：现象成立，归因和降 tier 建议不成立。** 当前上下文是 AG 解码的
> side information，LTG 不应依赖某次 compaction summary 的内容决定持久等级。
> 正确方向是会话注入窗口/AG 做覆盖抑制，保留 LTG 的跨会话权威性。

现象/证据：本会话被压缩后，summary 已完整携带 pi-lsp 的安装路径、命令、
工具清单等状态——和 LTG 里的记录高度重合。于是"取记忆"相对 summary 没有
新增信息，取用动机自然为零。

根因：LTG 与"会话内上下文（compaction summary）"职责没有区分，同一份状态
双份存在，而**取用方看不到哪份更权威**。

建议：

- 区分"跨会话持久"（LTG）与"会话内 context"：写入时若信息大概率进 summary，
  标记为会话冗余或降 tier，让 LTG 里只剩 summary 覆盖不到的东西。
- 或反过来：取用时让 LTG 记录相对 summary **有增量价值**（如更精确的机制
  细节、跨会话演进时间线），否则它只是 summary 的影子。

## 5. 一致性维护靠事后翻查，而非制度

> **设计意见：部分接受。** state supersession 和反馈驱动 supersede 已在设计中；
> 缺的是 Pi 写入契约和反馈接线。只应复核实际取用的易变记录，避免默认会话结束
> 再增加一次全库 LLM 维护调用。

现象/证据：最后真正 `nmg_get` 取回时，立刻发现 3 条过期/失准记录：
`pi-lsp-patch-constraint` 的前提（pi update 会覆盖补丁）在 vendor 化后已
不成立、`pi-lsp-11-tools` 对 workspace symbol 机制描述过粗、`pi-lsp-setup-windows`
还指向 vendor 前的旧路径。取用本身是有产出的（发现了 stale），但这是
**侥幸翻到**，不是设计保证。

根因：没有写侧 supersede 语义，也没有"会话结束时复查已存记录"的制度；
一致性完全靠 agent 在某个时刻想起去对账。

建议：

- 写侧支持 `supersededBy` / 版本时间线（见第 3 点），旧事实自动降权。
- 会话结束或任务切换时，对"本次依赖过的记录"做一次准确性复查（正是
  08-06 第 1 点"会话结束一键总结"的对偶：不只总结写入，也核对已存的）。

## 附 A：做得好的地方

- **plumbing 是通的**：真正取用时，`nmg_search` 召回 6 条、`nmg_get` 正确
  返回证据，且确实翻出了过期的 patch-constraint——证明存储与检索管线本身
  没问题，坏在触发与沉淀设计。
- **渐进披露依然好用**：header → evidence 的两级结构对 token 友好。
- **stateKey 约定有效**：本会话统一用 `pi-lsp-env`，让 6 条记录可归并检索，
  若没有这个 key，问题只会更严重。

## 附 B：policy 措辞修订建议（把"许可"改成"持续警觉"）

原文："For the latest user request, decide which candidates matter, whether
one or several records are needed, and whether more recall or current
verification is required."

建议改为：

> For the latest user request, decide which candidates matter — you may ignore
> clearly irrelevant noise, but that is a per-request decision, not a
> session-wide waiver. If this session is working on a domain with saved
> records (a project/extension/env you have state or constraint records for),
> consult memory before acting on it. Once you have used memory this session
> (searched, retrieved, or saved), check back at task switches and before
> state-changing edits, and re-verify that saved records you relied on are
> still current. If the recalled headers under-determine the answer, request
> additional evidence (append/re-fetch) before guessing. Do not treat candidate
> count as completeness or a memory as current truth. Save only attributable,
> durable information; do not save secrets, transient content, unconfirmed
> assistant proposals, or unsupported guesses.

位置：`src/prompts/nmg-prompts.yaml:105` 附近。
