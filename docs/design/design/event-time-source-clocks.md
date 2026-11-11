# Event-time source clocks

[简体中文](event-time-source-clocks.zh-CN.md) · [Terms](event-time-source-clocks.terms.yaml)

**Authority:** [Core data model](core-data-model.md).

## Source clocks for event time

`RememberInput` and `remember`/`rememberBatch` accept optional `referenceTime`
and `timeZone` for interpreting the supplied `eventTime`. `referenceTime` must
be a valid ISO datetime with `Z` or an explicit offset. `timeZone` accepts an
IANA zone or a fixed `±HH:MM` offset. When only `referenceTime` is supplied, its
written offset defines the source calendar. A named zone uses the calendar at
that source instant, including daylight-saving changes. Each batch item owns
its context. Invalid contexts are rejected even when `eventTime` is absolute
or absent. These fields neither extract dates from `statement` nor set validity
intervals, expiry, or ingestion timestamps.

For example, `eventTime="昨天"`, `referenceTime="2025-05-10T00:30:00+08:00"`
and `timeZone="Asia/Shanghai"` resolve to `2025-05-09T00:00:00.000Z`, independent
of replay date and host zone. Day/month/year phrases retain UTC labels for
their calendar grain. Hour offsets use elapsed time; an explicitly zoned event
timestamp retains its stated instant. Without `referenceTime`, writes use the
actual write clock and the supplied zone, or the host locale when it is absent.
Importers supply absolute event times or an explicit historical context.

Core, portable memory, RPC, CLI (`--reference-time`, `--time-zone`), Pi, MCP,
OpenCode and both DSH adapters accept the context. RPC clients require
`event-time-reference` in the owner's capabilities before sending contextual
writes. Ordinary writes remain compatible with earlier owners. The context is
an input to normalization; it does not add persistent record fields. Source
evidence remains unchanged.

Legacy normalization repairs only complete absolute dates. Unanchored relative
and year-omitted phrases retain their source text, and cannot satisfy event-time
SQL bounds or acquire a new date during ranking. Previously misresolved
canonical dates cannot be identified automatically; correction needs original
source evidence. Historical-query clocks and statement-time extraction remain
separate work.
