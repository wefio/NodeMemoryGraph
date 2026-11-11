/**
 * Event-time normalization and window extraction.
 *
 * One canonical form is stored and compared: a fixed-width UTC instant
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`). That matters beyond tidiness — candidate SQL
 * compares `event_time` as TEXT, and the three shapes agent writes used to
 * produce (`2026-10-13`, `2026-10-13T07:30:45.236Z`, `2026-09-19T21:31:55+08:00`)
 * do not sort chronologically against each other: the offset form compares as
 * if it were UTC, and a date-only bound `2026-06-30` excludes that whole day.
 *
 * Date-only phrases keep meaning "that calendar day". The day is read from the
 * phrase (or from the source calendar, defaulting to the caller's locale)
 * and recorded as UTC midnight,
 * so a day-granularity query and a day-granularity write agree exactly.
 *
 * Chinese is resolved here rather than in the retrieval path: agents issue
 * "上周三干了什么" and "3月10号之前", and a window that never binds silently
 * returns semantic-only rankings that ignore `event_time` entirely.
 */

export type EventGranularity = "year" | "month" | "day" | "minute";

export interface ParsedEventTime {
  /** Canonical UTC start instant of the granularity the phrase stated. */
  start: string;
  /** How much of the calendar the phrase covered; bounds expand to its end. */
  granularity: EventGranularity;
}

/** Source clock for interpreting an explicitly supplied eventTime phrase.
 * Ingestion timestamps always retain the actual write clock. */
export interface EventTimeContext {
  referenceTime?: string;
  timeZone?: string;
}

interface EventClock {
  instant: Date;
  calendar: Required<Pick<DateParts, "year" | "month" | "day">>;
}

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** SQLite GLOB shape for already-normalized stored event instants. */
export const CANONICAL_EVENT_TIME_GLOB = "????-??-??T??:??:??.???Z";
const END_OF_DAY = "T23:59:59.999Z";

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Builds a UTC instant from calendar parts; rejects rolled-over dates. */
function instant(parts: DateParts, granularity: EventGranularity): ParsedEventTime | null {
  const { year, month, day, hour = 0, minute = 0 } = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  // Date.UTC rolls February 31 into March, so the parts must survive a round trip.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { start: date.toISOString(), granularity };
}

/** Calendar parts of an instant, read in the caller's zone: "today" is local. */
function localParts(now: EventClock): EventClock["calendar"] {
  return now.calendar;
}

function shiftDay(now: EventClock, days: number): ParsedEventTime | null {
  const base = localParts(now);
  const date = new Date(Date.UTC(base.year, base.month - 1, base.day));
  date.setUTCDate(date.getUTCDate() + days);
  return instant(
    { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    "day",
  );
}

function shiftMonth(now: EventClock, months: number): ParsedEventTime | null {
  const base = localParts(now);
  const index = base.year * 12 + (base.month - 1) + months;
  return instant({ year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 }, "month");
}

function shiftYear(now: EventClock, years: number): ParsedEventTime | null {
  return instant({ year: localParts(now).year + years, month: 1, day: 1 }, "year");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 三 → 3, 十一 → 11, 二十三 → 23, 十九 → 19. Returns null for anything else. */
function cnNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const ten = text.indexOf("十");
  if (ten < 0) return text.length === 1 ? (CN_DIGIT[text] ?? null) : null;
  const tens = text.slice(0, ten);
  const ones = text.slice(ten + 1);
  const high = tens === "" ? 1 : CN_DIGIT[tens];
  const low = ones === "" ? 0 : CN_DIGIT[ones];
  if (high === undefined || low === undefined) return null;
  return high * 10 + low;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// ── absolute phrases ────────────────────────────────────────────────────────

const ISO_DAY =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_DAY = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/;
const CJK_DAY = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]\s*(?:(\d{1,2})[:：](\d{2}))?$/;
const CJK_MONTH = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:份)?$/;
const CJK_YEAR = /^(\d{4})\s*年$/;
const BARE_CJK_DAY = /^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]$/;
const EN_MONTH_DAY = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const EN_MONTH = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/;

/** ISO day, ISO datetime (with optional offset) and `YYYY/M/D`. */
function isoInstant(text: string): ParsedEventTime | null {
  if (CANONICAL.test(text)) {
    const date = new Date(text);
    return Number.isFinite(date.getTime()) && date.toISOString() === text
      ? { start: text, granularity: "minute" }
      : null;
  }
  const date = text.match(ISO_DAY);
  if (date) return isoDayParts(date);
  const slash = text.match(SLASH_DAY);
  if (!slash) return null;
  const timed = slash[4] !== undefined;
  return instant(
    {
      year: +slash[1]!,
      month: +slash[2]!,
      day: +slash[3]!,
      hour: timed ? +slash[4]! : 0,
      minute: timed ? +slash[5]! : 0,
    },
    timed ? "minute" : "day",
  );
}

function isoDayParts(match: RegExpMatchArray): ParsedEventTime | null {
  const [, y, m, d, h, min, sec, fraction, zone] = match;
  if (h === undefined) return instant({ year: +y!, month: +m!, day: +d! }, "day");
  // Time-of-day stated: keep the seconds it named, not just the minute.
  const millis = fraction === undefined ? "000" : fraction.padEnd(3, "0");
  const stamp = `${y}-${pad(+m!)}-${pad(+d!)}T${pad(+h)}:${min}:${sec ?? "00"}.${millis}`;
  if (zone) {
    // A zoned datetime is an instant, not a calendar day.
    const zoned = new Date(`${stamp}${zone === "Z" ? "Z" : zone}`);
    return Number.isFinite(zoned.getTime())
      ? { start: zoned.toISOString(), granularity: "minute" }
      : null;
  }
  const calendar = instant({ year: +y!, month: +m!, day: +d!, hour: +h, minute: +min! }, "minute");
  return calendar ? { start: `${stamp}Z`, granularity: "minute" } : null;
}

/** `2026年11月6日`, `2026年11月`, `2026年`, `11月6日`. */
function chineseDateInstant(text: string, now?: EventClock): ParsedEventTime | null {
  const day = text.match(CJK_DAY);
  if (day) return cjkDayParts(day);
  const bare = text.match(BARE_CJK_DAY);
  if (bare) return now ? bareDayParts(bare, now) : null;
  const month = text.match(CJK_MONTH);
  if (month) return instant({ year: +month[1]!, month: +month[2]!, day: 1 }, "month");
  const year = text.match(CJK_YEAR);
  return year ? instant({ year: +year[1]!, month: 1, day: 1 }, "year") : null;
}

function cjkDayParts(match: RegExpMatchArray): ParsedEventTime | null {
  const [, year, month, day, hour, minute] = match;
  const timed = hour !== undefined;
  return instant(
    {
      year: +year!,
      month: +month!,
      day: +day!,
      hour: timed ? +hour : 0,
      minute: timed ? +minute! : 0,
    },
    timed ? "minute" : "day",
  );
}

/** A year-omitted phrase means its most recent occurrence, never the future. */
function bareDayParts(match: RegExpMatchArray, now: EventClock): ParsedEventTime | null {
  const { year, month, day } = localParts(now);
  const candidate = instant({ year, month: +match[1]!, day: +match[2]! }, "day");
  if (candidate && Date.parse(candidate.start) <= Date.UTC(year, month - 1, day)) return candidate;
  return instant({ year: year - 1, month: +match[1]!, day: +match[2]! }, "day");
}

/** `Mar 10, 2029`, `March 2029`. */
function englishMonthInstant(text: string): ParsedEventTime | null {
  const day = text.match(EN_MONTH_DAY);
  if (day) {
    const month = MONTHS[day[1]!.toLowerCase().slice(0, 3)];
    return month ? instant({ year: +day[3]!, month, day: +day[2]! }, "day") : null;
  }
  const month = text.match(EN_MONTH);
  if (!month) return null;
  const number = MONTHS[month[1]!.toLowerCase().slice(0, 3)];
  return number ? instant({ year: +month[2]!, month: number, day: 1 }, "month") : null;
}

function parseAbsolute(text: string, now?: EventClock): ParsedEventTime | null {
  return isoInstant(text) ?? chineseDateInstant(text, now) ?? englishMonthInstant(text);
}

// ── relative phrases ────────────────────────────────────────────────────────

const WEEKDAY: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
const SPAN_DELTA: Record<string, number> = { 上: -1, 下: 1, 这: 0, 本: 0 };
const YEAR_WORD_DELTA: Record<string, number> = { 前: -2, 去: -1, 今: 0, 本: 0, 明: 1 };

const FIXED_DAYS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:今天|今日|当天)$/, 0],
  [/^(?:昨天|昨日|昨晚)$/, -1],
  [/^(?:前天|前日)$/, -2],
  [/^大前天$/, -3],
  [/^(?:明天|明日)$/, 1],
  [/^(?:后天|后日)$/, 2],
  [/^大后天$/, 3],
];
const NOW_WORDS = /^(?:刚才|刚刚|这会儿|现在)$/;
const WEEK_DAY = /^(上|下|这|本)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])$/;
const WEEK_SPAN = /^(上|下|这|本)(?:个)?(?:周|星期|礼拜)$/;
const MONTH_SPAN = /^(上|下|这|本)(?:个)?月(?:份)?$/;
const YEAR_SPAN = /^(前|去|明|今|本)年$/;
const OFFSET_SPAN =
  /^(\d+|[一二三四五六七八九十两]+)\s*(小时|天|日|周|星期|礼拜|个月|月|年)(前|后|以前|以后)$/;

/** Monday-based offset of a local weekday, so 本周三 is stable across locales. */
function weekdayOffset(now: EventClock): number {
  const { year, month, day } = now.calendar;
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function fixedDay(text: string, now: EventClock): ParsedEventTime | null {
  const entry = FIXED_DAYS.find(([pattern]) => pattern.test(text));
  return entry ? shiftDay(now, entry[1]) : null;
}

function weekDay(text: string, now: EventClock): ParsedEventTime | null {
  const match = text.match(WEEK_DAY);
  if (!match) return null;
  const delta = SPAN_DELTA[match[1]!]! * 7;
  return shiftDay(now, delta + WEEKDAY[match[2]!]! - weekdayOffset(now));
}

function weekSpan(text: string, now: EventClock): ParsedEventTime | null {
  const match = text.match(WEEK_SPAN);
  return match ? shiftDay(now, SPAN_DELTA[match[1]!]! * 7 - weekdayOffset(now)) : null;
}

function monthSpan(text: string, now: EventClock): ParsedEventTime | null {
  const match = text.match(MONTH_SPAN);
  return match ? shiftMonth(now, SPAN_DELTA[match[1]!]!) : null;
}

function yearSpan(text: string, now: EventClock): ParsedEventTime | null {
  const match = text.match(YEAR_SPAN);
  return match ? shiftYear(now, YEAR_WORD_DELTA[match[1]!]!) : null;
}

function offsetSpan(text: string, now: EventClock): ParsedEventTime | null {
  const match = text.match(OFFSET_SPAN);
  if (!match) return null;
  const amount = cnNumber(match[1]!);
  if (amount === null) return null;
  const signed = match[3] === "前" || match[3] === "以前" ? -amount : amount;
  if (match[2] === "小时") {
    const stamp = new Date(now.instant.getTime() + signed * 3_600_000).toISOString();
    return { start: stamp, granularity: "minute" };
  }
  if (match[2] === "天" || match[2] === "日") return shiftDay(now, signed);
  if (match[2] === "周" || match[2] === "星期" || match[2] === "礼拜")
    return shiftDay(now, signed * 7);
  if (match[2] === "月" || match[2] === "个月") return shiftMonth(now, signed);
  return shiftYear(now, signed);
}

const EN_UNIT_DAYS: Record<string, number> = { day: 1, week: 7 };

function parseEnglishRelative(text: string, now: EventClock): ParsedEventTime | null {
  const lower = text.toLowerCase();
  if (lower === "today" || lower === "tonight") return shiftDay(now, 0);
  if (lower === "yesterday") return shiftDay(now, -1);
  if (lower === "tomorrow") return shiftDay(now, 1);
  const ago = lower.match(/^(\d+)\s+(hour|day|week|month|year)s?\s+ago$/);
  if (ago) return englishOffset(+ago[1]!, ago[2]!, now, -1);
  const span = lower.match(/^(last|this|next)\s+(day|week|month|year)$/);
  if (!span) return null;
  return englishOffset(1, span[2]!, now, span[1] === "last" ? -1 : span[1] === "next" ? 1 : 0);
}

function englishOffset(
  amount: number,
  unit: string,
  now: EventClock,
  sign: number,
): ParsedEventTime | null {
  const signed = amount * sign;
  if (unit === "hour")
    return {
      start: new Date(now.instant.getTime() + signed * 3_600_000).toISOString(),
      granularity: "minute",
    };
  if (unit === "month") return shiftMonth(now, signed);
  if (unit === "year") return shiftYear(now, signed);
  return shiftDay(now, signed * EN_UNIT_DAYS[unit]!);
}

function parseRelative(text: string, now: EventClock): ParsedEventTime | null {
  const nowWord = text.match(NOW_WORDS);
  if (nowWord) return { start: now.instant.toISOString(), granularity: "minute" };
  return (
    fixedDay(text, now) ??
    weekDay(text, now) ??
    weekSpan(text, now) ??
    monthSpan(text, now) ??
    yearSpan(text, now) ??
    offsetSpan(text, now) ??
    parseEnglishRelative(text, now)
  );
}

// ── public API ──────────────────────────────────────────────────────────────

/** Resolves any accepted phrase to a canonical start instant plus its granularity. */
export function parseEventTime(
  raw: string | null | undefined,
  now: Date = new Date(),
  timeZone?: string,
): ParsedEventTime | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const clock = eventClock(now, timeZone);
  return parseAbsolute(text, clock) ?? parseRelative(text, clock);
}

/** Canonical stored/compared form: UTC instant, fixed width, or null. */
export function normalizeEventTime(
  raw: string | null | undefined,
  now: Date = new Date(),
  timeZone?: string,
): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (CANONICAL.test(text)) return text;
  return parseEventTime(raw, now, timeZone)?.start ?? null;
}

/** Repair/read an existing value without inventing a missing source clock. */
export function normalizeAbsoluteEventTime(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  return parseAbsolute(raw.trim())?.start ?? null;
}

function eventClock(now: Date, timeZone?: string): EventClock {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid event referenceTime");
  if (timeZone === undefined)
    return {
      instant: now,
      calendar: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    };
  const offset = timeZone.match(/^([+-])(\d{2}):(\d{2})$/);
  if (offset) return offsetClock(now, offset);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    return {
      instant: now,
      calendar: { year: values.year!, month: values.month!, day: values.day! },
    };
  } catch {
    throw new Error("Invalid event timeZone");
  }
}

function offsetClock(now: Date, offset: RegExpMatchArray): EventClock {
  const hours = Number(offset[2]);
  const minutes = Number(offset[3]);
  if (hours > 23 || minutes > 59) throw new Error("Invalid event timeZone offset");
  const direction = offset[1] === "+" ? 1 : -1;
  const date = new Date(now.getTime() + direction * (hours * 60 + minutes) * 60_000);
  return {
    instant: now,
    calendar: {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    },
  };
}

/** Explicit source timestamps must state their zone. Without an IANA zone,
 * their written offset is the source calendar, independent of the host zone. */
function sourceClock(context: EventTimeContext, fallback: Date): EventClock {
  if (context.referenceTime === undefined) return eventClock(fallback, context.timeZone);
  const match = context.referenceTime.match(ISO_DAY);
  if (
    !match ||
    !match[4] ||
    !match[8] ||
    !instant({ year: +match[1]!, month: +match[2]!, day: +match[3]! }, "day")
  )
    throw new Error("referenceTime requires a valid ISO timestamp with Z or an explicit offset");
  const now = new Date(context.referenceTime);
  const zone = match[8] === "Z" ? "UTC" : match[8]!.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return eventClock(now, context.timeZone ?? zone);
}

export function resolveWriteEventTime(
  raw: string | null | undefined,
  context: EventTimeContext,
  writeClock: Date = new Date(),
): string | null | undefined {
  const clock = sourceClock(context, writeClock);
  if (raw === undefined || raw === null) return raw;
  const text = raw.trim();
  return (parseAbsolute(text, clock) ?? parseRelative(text, clock))?.start ?? raw;
}

/** Write-time resolution: the canonical instant when the phrase resolves against
 *  the write clock, otherwise the author's own text, which is kept as evidence
 *  but never used for ordering or window comparison. */
export function resolveEventTime(
  raw: string | null | undefined,
  now: Date = new Date(),
  timeZone?: string,
): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  return normalizeEventTime(raw, now, timeZone) ?? raw;
}

/** Stored values need complete dates. A caller can explicitly anchor a query phrase. */
export function eventTimeMillis(raw: string | null | undefined, now?: Date): number | null {
  const canonical = now ? normalizeEventTime(raw, now) : normalizeAbsoluteEventTime(raw);
  if (!canonical) return null;
  const millis = Date.parse(canonical);
  return Number.isFinite(millis) ? millis : null;
}

function endOfGranularity(parsed: ParsedEventTime): string {
  const start = new Date(parsed.start);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  switch (parsed.granularity) {
    case "minute":
      return parsed.start;
    case "day":
      return `${parsed.start.slice(0, 10)}${END_OF_DAY}`;
    case "month":
      return `${year}-${pad(month)}-${pad(daysInMonth(year, month))}${END_OF_DAY}`;
    case "year":
      return `${year}-12-31${END_OF_DAY}`;
  }
}

/** Inclusive lower bound of a window side; null when the phrase is unusable. */
export function eventWindowStart(
  raw: string | null | undefined,
  now: Date = new Date(),
): string | null {
  // A lower bound starts at the day itself, not at the grain's end.
  return parseEventTime(raw, now)?.start ?? null;
}

/** Inclusive upper bound: a date phrase covers its whole day/month/year. */
export function eventWindowEnd(
  raw: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const parsed = parseEventTime(raw, now);
  return parsed ? endOfGranularity(parsed) : null;
}

// ── Chinese query windows ───────────────────────────────────────────────────

const DAY_TOKEN =
  "(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{4}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号])";

const RELATIVE_TOKEN =
  "(?:大前天|大后天|今天|今日|昨天|昨日|前天|前日|明天|明日|后天|后日|刚才|刚刚|" +
  "(?:上|下|这|本)(?:个)?(?:周|星期|礼拜)[一二三四五六日天]|" +
  "(?:上|下|这|本)(?:个)?(?:周|星期|礼拜|月)|" +
  "(?:前|去|明|今|本)年|" +
  "(?:\\d+|[一二三四五六七八九十两]+)\\s*(?:小时|天|日|周|星期|礼拜|个月|月|年)(?:前|后|以前|以后))";

const CN_TOKEN = new RegExp(`${RELATIVE_TOKEN}|${DAY_TOKEN}`);
const CN_RANGE = new RegExp(
  `(?:从|自)?\\s*(${RELATIVE_TOKEN}|${DAY_TOKEN})\\s*(?:到|至|~|-|—)\\s*(${RELATIVE_TOKEN}|${DAY_TOKEN})`,
);

/** A date mention only binds a window when the query also asks about time. */
const TEMPORAL_INTENT =
  /什么时候|啥时候|何时|什么时间|哪天|哪一天|几号|哪个月|哪年|多久|多长时间|什么|啥|干了|做过|发生了什么|之前|之后|以前|以后|期间|当时|那天|那阵|最近|这阵子|从.*到/;

/** Relational markers turn one date into an open-ended side of the window. */
const BEFORE = /之前|以前/;
const AFTER = /之后|以后|以来/;

function chineseRange(text: string, now: Date): { from?: string; to?: string } | null {
  const match = text.match(CN_RANGE);
  if (!match) return null;
  const from = eventWindowStart(match[1]!.trim(), now);
  const to = eventWindowEnd(match[2]!.trim(), now);
  return from || to ? { ...(from ? { from } : {}), ...(to ? { to } : {}) } : null;
}

/** Absolute mentions need temporal intent; relative phrases bind on their own. */
function bindsWindow(text: string, phrase: string): boolean {
  if (new RegExp(`^${RELATIVE_TOKEN}$`).test(phrase)) return true;
  if (TEMPORAL_INTENT.test(text)) return true;
  const remainder = text.replace(phrase, "").replace(/[的了呢吧啊？?。，,、!！\s]/gu, "");
  return remainder.length <= 2;
}

/**
 * Chinese and relative windows. Absolute date mentions need temporal intent in
 * the same query — "把 2026年11月6日 的会议记下来" is a statement, not a query —
 * while pure relative phrases are indexical enough to bind on their own.
 */
export function extractChineseEventWindow(
  text: string,
  now: Date = new Date(),
): { from?: string; to?: string } {
  if (!text) return {};
  const range = chineseRange(text, now);
  if (range) return range;
  const found = text.match(CN_TOKEN);
  if (!found || !bindsWindow(text, found[0])) return {};
  const start = eventWindowStart(found[0], now);
  const end = eventWindowEnd(found[0], now);
  if (!start) return {};
  // "3月10号之前" bounds the past up to that day; "之后" bounds from that day on.
  const relation = text.slice(found.index! + found[0].length);
  if (BEFORE.test(relation)) return end ? { to: end } : {};
  if (AFTER.test(relation)) return { from: start };
  return { from: start, ...(end ? { to: end } : {}) };
}
