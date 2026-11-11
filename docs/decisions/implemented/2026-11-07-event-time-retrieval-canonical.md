# Resolve event times to one canonical instant and consume them on the read path

[中文](2026-11-07-event-time-retrieval-canonical.zh-CN.md) · [Terms](2026-11-07-event-time-retrieval-canonical.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

`event_time` was written verbatim and read by nobody. Four shapes coexisted in
one live store: `2026-10-13`, `2026-10-13T07:30:45.236Z`,
`2026-07-23T09:14:30.890Z` and `2026-09-19T21:31:55+08:00`. Candidate SQL
compares that column as TEXT (`m.event_time >= ?`), so the offset shape sorts as
if it were UTC — `21:31+08:00` is `13:31Z` but compares after `20:00Z`.

Three separate defects followed from that, each invisible on its own:

- **The write path refused dates it should have accepted.** `assertTemporalValidity`
  ran `Date.parse` on the raw string, so `eventTime: "2026年11月6日"` threw
  `eventTime must be a valid timestamp` and `"上周三"` was not even considered.
  An agent had no way to record a Chinese date.
- **The window parser only spoke English.** `extractEventWindow` matched
  `as of …`, `on …`, `from … to …` and ISO days. `上周三干了什么` bound no window,
  so retrieval ranked semantically and ignored `event_time` entirely — the
  column was storage, not evidence.
- **`time:` never reached candidate generation.** `parseAdvancedQuery` produced
  `filters.eventTimeFrom/To`, and the service applied them with
  `applyAdvancedFilters` **after** the top-k was chosen. Out-of-window memories
  occupied the slots and a selective window could return nothing. The upper
  bound was also off by a day: `time:2026-01-01..2026-06-30` bounded at
  `2026-06-30T00:00Z`, dropping that whole day.

1106 of 1240 records carried no `event_time` at all, so any window silently
excluded most of the store.

## Decision

One module, `src/core/event-time.ts`, owns the vocabulary: `normalizeEventTime`
canonicalizes a phrase to a fixed-width UTC instant
(`YYYY-MM-DDTHH:mm:ss.sssZ`), `parseEventTime` also reports the granularity the
phrase stated, and `eventWindowStart` / `eventWindowEnd` widen a bound to the
grain's first and last instant. Accepted input: ISO day and datetime with or
without an offset, `YYYY/M/D`, `YYYY.M.D`, `2026年11月6日[ 14:30]`, `11月6日`
(year inferred, never in the future), and the relative phrases `今天/昨天/前天/
大前天/明天/后天`, `本周X/上周X/下周X`, `本月/上个月/去年/明年`, `N天前`,
`两周以前`, `3个月前`, `刚才`, plus `today/yesterday/N days ago/last month`.

Writes resolve once, against the explicit source clock when supplied, otherwise
the write clock: `newMemory` (portable plan) and
`addMemory` (store) both store the canonical instant, so a replay cannot drift
with the reading clock. `assertTemporalValidity` resolves before it judges, so a
stated day is accepted while genuine garbage (`傍晚`) is still refused. A phrase
that resolves is stored canonically; one that does not keeps the author's words
for evidence and never reaches `valid_from`.

Reads consume the column, in the layer that can filter:

- `extractEventWindow` delegates to the same module and gains Chinese: bare and
  `从…到…` ranges, `之前`/`之后` as an open side, and relative phrases. Both
  bounds come back canonical and inclusive.
- An absolute Chinese date binds a window only when the query also asks about
  time (`什么时候/哪天/之前/最近/从…到…`); pure relative phrases are indexical
  enough to bind alone. A statement that mentions a date — `把 2026年11月6日 的
  会议记下来` — keeps its semantic ranking.
- `parseAdvancedQuery` reports `eventTimeSource: "explicit" | "natural"`, and the
  service passes the window into `SearchOptions`, so it filters in candidate SQL
  instead of after the top-k.
- A window is reachable as data, not only as query syntax: `NmgSearchParams`
  carries `eventTimeFrom`/`eventTimeTo` (CLI `nmg search --from/--to`, DSH
  `nmg_search` parameters). A bound that resolves to no instant is rejected as
  `INVALID_PARAMS` rather than silently dropped, because a dropped bound answers
  a different question than the caller asked.
- The parameter set is host-neutral: `src/integration/tool-contract.ts` holds
  `SEARCH_TOOL_PARAMETERS`, one JSON-Schema description per retrieval parameter.
  The DSH plugin, the legacy composition plugin and the OpenCode adapter project
  it directly; the Pi extension and the MCP server, whose schema libraries
  (TypeBox, zod) cannot take JSON Schema verbatim, declare their own fields and
  are held to the table by a test that reads the live tool schema. A capability
  added to the table reaches every host, or a test fails.
- A `"natural"` window is a hint: when it leaves nothing (most records carry no
  `event_time`), the service retries once with `interpretTemporalQuery: false`
  rather than answering "no memory" to a question that has one. An explicit
  `time:` operator stays hard.
- `searchWithVector` normalizes both bounds before binding, so a date-only
  `SearchOptions.eventTimeTo` covers its whole day; as-of ranking, recency decay,
  supersession resolution and the post-filter all compare canonical instants
  through `eventTimeMillis`.

`migrate` repairs complete absolute dates in noncanonical `event_time` or
`valid_from` values. A GLOB guard skips canonical rows. Relative, year-omitted
and unparseable text stays untouched: the opening clock cannot supply missing
source evidence. Temporal SQL bounds require canonical stored instants.

### Historical replay correction

Resolving once prevents reading-clock drift, but using ingestion time for a
historical source still permanently anchors the wrong date. The
[source-clock contract](../../design/design/event-time-source-clocks.md)
adds an explicit source anchor and zone to existing writes, while preserving
actual ingestion timestamps. We chose per-item input over a global clock or a
rewritten `createdAt`: imports can mix source dates and concurrent live writes.
An owner capability check prevents older daemons from silently dropping the
new fields. Migration and ranking leave unanchored source phrases unresolved.

Isolated regressions cover different ingestion dates and host zones, source
offsets, DST, elapsed hours, invalid contexts, old-owner rejection, batch
isolation, reopen, temporal SQL bounds and the actual CLI/Pi/MCP/DSH/OpenCode
entry points. They do not establish deployment or improved benchmark scores.
Already-misresolved canonical records require source-backed correction.

## Alternatives considered

- **Compare with `Date.parse` at every site and keep the stored text.** Leaves
  four shapes in the column and keeps the SQL comparison wrong; every future
  reader would have to remember to normalize.
- **Store the phrase and add a derived `event_time_ms INTEGER` column.** Correct
  ordering, but it doubles the surface: two columns to keep in sync, an index
  migration, and every existing query rewritten.
- **Filter NL windows as hard constraints like `time:`.** With 89% of records
  undated, `上周三干了什么` would answer "nothing" — a parse improvement that makes
  recall worse.
- **Parse Chinese only in the DSH adapter.** Three surfaces search (daemon, CLI,
  DSH); a phrase would mean different things depending on who asked.
- **Resolve relative phrases at read time.** `上周三` would then mean a different
  day next week, and a stored memory would drift as the clock advances.

## Consequences

Bound upper sides change value: `extractEventWindow("on Sep 13, 2029").to` used
to be `2029-09-14` (the next day, meant to be exclusive) and is now
`2029-09-13T23:59:59.999Z`. Tests asserting the old shape were updated; the
inclusion set is unchanged, and `as of` now includes the whole named day instead
of stopping at its midnight.

Every resolvable complete absolute timestamp is rewritten once on the next
store open. Nothing rewrites `created_at`, `expires_at` or history rows.

Chinese date mentions inside paraphrased statements stay unbound, which is the
cost of the intent gate: `把 2026年11月6日 的会议记下来` searches by wording only.

## Deferred

Nothing infers `event_time` from a statement (`我上周三去了东京` stays undated), so
the 89% undated share only falls as agents supply the field. The soft-window
retry covers that gap at read time; closing it at write time is a separate
extraction problem.
