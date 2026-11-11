# 事件时间统一解析为一个规范时刻，并让检索链路真正消费它

[English](2026-11-07-event-time-retrieval-canonical.md) · [术语](2026-11-07-event-time-retrieval-canonical.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

`event_time` 写入时原样保存，读取时无人消费。同一个线上库里并存四种形状：
`2026-10-13`、`2026-10-13T07:30:45.236Z`、`2026-07-23T09:14:30.890Z` 与
`2026-09-19T21:31:55+08:00`。候选 SQL 把该列当 TEXT 比较（`m.event_time >= ?`），
于是带偏移的形状会被当成 UTC——`21:31+08:00` 实际是 `13:31Z`，比较时却排在
`20:00Z` 之后。

由此引出三个各自不易察觉的缺陷：

- **写入链路拒绝了本该接受的日期。** `assertTemporalValidity` 对原始字符串直接
  `Date.parse`，`eventTime: "2026年11月6日"` 抛
  `eventTime must be a valid timestamp`，`"上周三"` 根本不在考虑之内。Agent
  无法记录一个中文日期。
- **时间窗解析只说英文。** `extractEventWindow` 只匹配 `as of …`、`on …`、
  `from … to …` 和 ISO 日期。`上周三干了什么` 不绑定任何窗口，检索退化为纯语义
  排序，完全忽略 `event_time`——该列只是存储，不是证据。
- **`time:` 从未进入候选生成。** `parseAdvancedQuery` 产出
  `filters.eventTimeFrom/To`，服务在 top-k 选完之后才用 `applyAdvancedFilters`
  过滤。窗口外的记忆先占了名额，选择性强的窗口可能一条都返回不了。上界还差一天：
  `time:2026-01-01..2026-06-30` 的界是 `2026-06-30T00:00Z`，整天被排除。

1240 条记录中有 1106 条完全没有 `event_time`，所以任何窗口都会静默排除库里的大
部分内容。

## 决策

词汇表集中到一个模块 `src/core/event-time.ts`：`normalizeEventTime` 把短语规范化为
定宽 UTC 时刻（`YYYY-MM-DDTHH:mm:ss.sssZ`），`parseEventTime` 同时报告短语声明的
粒度，`eventWindowStart` / `eventWindowEnd` 把边界扩到该粒度的第一个与最后一个
时刻。接受的输入：带或不带偏移的 ISO 日与时刻、`YYYY/M/D`、`YYYY.M.D`、
`2026年11月6日[ 14:30]`、`11月6日`（年份推断，且不落在未来），以及相对短语
`今天/昨天/前天/大前天/明天/后天`、`本周X/上周X/下周X`、`本月/上个月/去年/明年`、
`N天前`、`两周以前`、`3个月前`、`刚才`，再加上
`today/yesterday/N days ago/last month`。

写入只解析一次，提供来源时钟时采用该锚点，否则沿用写入时钟。`newMemory`（可移植计划）与 `addMemory`（store）
都存规范时刻，回放不会随读取时钟漂移。`assertTemporalValidity` 先解析再判定，因而
声明的日期被接受、真正的垃圾（`傍晚`）仍被拒绝。能解析的短语按规范存；解析不了的
保留原话作为证据，且绝不进入 `valid_from`。

读取在有筛选能力的那一层消费该列：

- `extractEventWindow` 改为委托同一模块，并获得中文能力：裸日期与 `从…到…` 区间、
  `之前`/`之后` 作为单侧开区间、相对短语。两侧边界都是规范且闭区间。
- 中文绝对日期只在查询同时问及时间时绑定窗口（`什么时候/哪天/之前/最近/从…到…`）；
  纯相对短语足够指向自身，可单独绑定。仅仅提到日期的陈述
  （`把 2026年11月6日 的会议记下来`）保持语义排序。
- `parseAdvancedQuery` 报告 `eventTimeSource: "explicit" | "natural"`，服务把窗口
  传进 `SearchOptions`，因而在候选 SQL 里过滤，而不是在 top-k 之后。
- 窗口可以作为数据传入，而不只是查询语法：`NmgSearchParams` 携带
  `eventTimeFrom`／`eventTimeTo`（CLI `nmg search --from/--to`、DSH
  `nmg_search` 参数）。解析不出时刻的边界会以 `INVALID_PARAMS` 拒绝，而不是静默
  丢弃——丢掉一个边界，回答的就不是调用方问的问题。
- 参数集合与宿主无关：`src/integration/tool-contract.ts` 里是
  `SEARCH_TOOL_PARAMETERS`，每个检索参数一份 JSON Schema 描述。DSH 插件、旧的
  composition 插件与 OpenCode 适配器直接投影它；Pi 扩展与 MCP 服务端所用的
  schema 库（TypeBox、zod）无法直接吃 JSON Schema，因此各自声明字段，并由一个
  读取真实工具 schema 的测试把它们钉在表上。往表里加一项，要么所有宿主都拿到，
  要么测试失败。
- `"natural"` 窗口是线索而非约束：当它筛空时（多数记录没有 `event_time`），服务用
  `interpretTemporalQuery: false` 重试一次，而不是对一个确实有答案的问题回答“没有
  记忆”。显式 `time:` 操作符仍是硬约束。
- `searchWithVector` 在绑定前规范化两侧边界，因此只写日期的
  `SearchOptions.eventTimeTo` 覆盖当天整天；as-of 排序、近期衰减、取代解析与后置
  过滤都通过 `eventTimeMillis` 比较规范时刻。

`migrate` 对非规范的 `event_time` 或 `valid_from` 值，只修复完整绝对日期。GLOB 守卫跳过规范行。相对短语、省略年份的短语和无法解析的文本保持原样；开库时钟不能补充缺失的来源证据。事件时间 SQL 边界只接受规范的存储时刻。

### 历史回放修正

只解析一次可以避免读取时钟漂移，但以摄入时间解释历史来源，仍会永久锚定到错误日期。[来源时钟契约](../../design/design/event-time-source-clocks.zh-CN.md)在已有写入上增加明确的来源锚点与时区，同时保留实际写入时间戳。选择逐条输入，避免全局时钟或重写 `createdAt`；同一导入可以混合多个来源日期，并与实时写入并发。Owner 能力检查防止旧 daemon 静默丢弃新字段。迁移和排序保留缺少来源锚点的短语，继续将其视为未解析。

隔离回归覆盖不同写入日期与宿主时区、来源偏移、夏令时、经过小时数、无效上下文、旧 owner 拒绝、批次隔离、重开数据库、时间 SQL 边界，以及真实 CLI／Pi／MCP／DSH／OpenCode 工具入口。这些验证不代表部署或 benchmark 分数改善。已经误解析成规范日期的记录，需要根据来源证据修正。

## 考虑过的替代方案

- **在各处用 `Date.parse` 比较，保留原始存储文本。** 列里仍是四种形状，SQL 比较
  依旧错，之后每个读取方都要自己记得规范化。
- **保留短语，另加派生列 `event_time_ms INTEGER`。** 排序正确，但表面翻倍：两列要
  同步、要一次索引迁移、所有既有查询都要改写。
- **把自然语言窗口像 `time:` 一样当硬约束。** 89% 记录没有日期时，
  `上周三干了什么` 会回答“没有”——一个让召回变差的解析改进。
- **只在 DSH 适配器里解析中文。** 三个入口在检索（daemon、CLI、DSH），同一短语会
  因谁在问而含义不同。
- **读取时再解析相对短语。** `上周三` 下周会指向另一天，已存的记忆会随时钟漂移。

## 后果

上界取值变了：`extractEventWindow("on Sep 13, 2029").to` 原先是 `2029-09-14`
（次日，意在开区间），现在是 `2029-09-13T23:59:59.999Z`。断言旧形状的测试已更新；
包含集合不变，而 `as of` 现在覆盖被命名的那整天，不再停在它的零点。

可解析的完整绝对时间戳会在下次打开库时被重写一次。`created_at`、`expires_at`
与历史表不做改写。

被复述的自然语句中的中文日期不绑定窗口，这是意图闸门的代价：
`把 2026年11月6日 的会议记下来` 只按措辞检索。

## 尚未完成

没有任何机制从陈述里推断 `event_time`（`我上周三去了东京` 仍然没有日期），因此 89%
的无日期比例只会随 Agent 主动填该字段而下降。读取侧的软窗口重试在检索时弥补这个
缺口；在写入侧闭合它是另一个抽取问题。
