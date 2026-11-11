# 事件时间的来源时钟

[English](event-time-source-clocks.md) · [术语](event-time-source-clocks.terms.yaml)

**权威范围：**[核心数据模型](core-data-model.zh-CN.md)。

## 事件时间的来源时钟

`RememberInput` 与 `remember`／`rememberBatch` 接受可选的 `referenceTime` 和 `timeZone`，用于解释显式提供的 `eventTime`。`referenceTime` 必须是带 `Z` 或明确偏移的有效 ISO 日期时间。`timeZone` 接受 IANA 时区或固定的 `±HH:MM` 偏移。只提供 `referenceTime` 时，其原始偏移定义来源日历。命名时区使用来源时刻所在的日历，包含夏令时变化。批次中的各条记录分别携带上下文。无效上下文会被拒绝，即使 `eventTime` 是绝对时间或未提供。这两个字段不从 `statement` 抽取日期，也不设置有效期、过期时间或写入时间戳。

例如，`eventTime="昨天"`、`referenceTime="2025-05-10T00:30:00+08:00"` 和 `timeZone="Asia/Shanghai"` 解析为 `2025-05-09T00:00:00.000Z`，不受回放日期和宿主时区影响。日／月／年短语保留对应日历粒度的 UTC 标签。小时偏移按经过时长计算；带明确时区的事件时间戳保留其表示的时刻。未提供 `referenceTime` 时，写入使用实际写入时钟，并采用指定时区；未指定时区则沿用宿主本地时区。导入方负责提供绝对事件时间或明确的历史上下文。

Core、可移植记忆、RPC、CLI（`--reference-time`、`--time-zone`）、Pi、MCP、OpenCode 和两种 DSH 适配器均接受该上下文。RPC 客户端发送携带上下文的写入前，要求 owner 公布 `event-time-reference` 能力。普通写入继续兼容旧 owner。上下文用于规范化，不增加持久化记录字段。来源证据保持原样。

旧值规范化只修复完整绝对日期。缺少锚点的相对短语和省略年份的短语保留原文，不能满足事件时间 SQL 边界，也不会在排序时获得新的日期。已经误解析为规范日期的记录无法自动识别，需要原始来源证据才能修正。历史查询时钟和陈述时间抽取仍是独立工作。
