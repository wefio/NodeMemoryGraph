/**
 * Advanced search query syntax for nmg_search — powered by the mature
 * `search-query-parser` package (MIT, zero-dependency), which implements
 * search-engine style operators (keyword:value lists, "-" exclusions,
 * quoted phrases) with correct Unicode/Chinese token handling.
 *
 *   "迈阿密 酒店 type:preference,constraint -海景"    filters + exclude
 *   node:"Conversation a1b2c3" 潜水                     node-scoped clause
 *   time:2026-01-01..2026-06-30 航班                   event-time window
 *
 * The parser strips structured operators out of the semantic text; the caller
 * runs the semantic remainder through normal retrieval and applies `filters`
 * as post-filters over the ranked candidates. Exclusions and phrases stay out
 * of the FTS expression (semantic + post-filter is precise enough at NMG's
 * evidence scale, and keeps the retrieval path free of FTS injection shapes).
 */

import sqp from "search-query-parser";

export interface AdvancedQueryFilters {
  /** memory_type values, OR-ed (comma list). */
  types?: string[];
  /** memory_nodes.canonical_name values, OR-ed. */
  nodeNames?: string[];
  /** state_key values, OR-ed. */
  stateKeys?: string[];
  /** event_time range (ISO date/datetime), inclusive. */
  eventTimeFrom?: string;
  eventTimeTo?: string;
  /** Plain tokens that must NOT appear (normalized) in a candidate. */
  excludeTerms: string[];
}

export interface ParsedAdvancedQuery {
  /** The natural-language remainder used for semantic retrieval. */
  semantic: string;
  filters: AdvancedQueryFilters;
}

const PARSER_OPTIONS = {
  keywords: ["type", "node", "state", "time"],
  tokenize: true,
  offsets: false,
};

type Parsed = {
  text?: string[] | string;
  type?: string | string[];
  node?: string;
  state?: string | string[];
  time?: string;
  exclude?: { text?: string | string[] };
};

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function parseDateRange(value: string): { from?: string; to?: string } {
  const parts = value.split("..");
  if (parts.length === 2) {
    return { from: parts[0] || undefined, to: parts[1] || undefined };
  }
  return { from: value, to: value };
}

// ── Natural-language event-time extraction ────────────────────────────────
// Benchmarks ask temporal questions ("as of Mar 10, 2029", "on Sep 13, 2029",
// "from Feb 28, 2035 to Feb 28, 2036"). Parse the date mention into an
// inclusive event-time window so retrieval filters by the question date
// instead of ranking future memories above the ones current at that time.

const MONTH_NUM: Record<string, number> = {
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

function isoDay(y: number, m: number, d: number, addDays = 0): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + addDays);
  return dt.toISOString().slice(0, 10);
}

const DATE_TOKEN =
  /[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{4}/;

function parseDateToken(text: string): { day: string; nextDay: string } | null {
  const t = text.trim();
  let m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i); // Mar 10, 2029
  if (m) {
    const mo = MONTH_NUM[m[1]!.toLowerCase().slice(0, 3)];
    if (mo) return { day: isoDay(+m[3]!, mo, +m[2]!), nextDay: isoDay(+m[3]!, mo, +m[2]!, 1) };
    return null;
  }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // 2029-03-10
  if (m) {
    const day = isoDay(+m[1]!, +m[2]!, +m[3]!);
    return { day, nextDay: isoDay(+m[1]!, +m[2]!, +m[3]!, 1) };
  }
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/i); // March 2029
  if (m) {
    const mo = MONTH_NUM[m[1]!.toLowerCase().slice(0, 3)];
    if (mo) {
      const last = new Date(Date.UTC(+m[2]!, mo, 0)).getUTCDate();
      return { day: isoDay(+m[2]!, mo, 1), nextDay: isoDay(+m[2]!, mo, last + 1) };
    }
    return null;
  }
  return null;
}

export function extractEventWindow(text: string): { from?: string; to?: string } {
  // 1) "from <D1> to <D2>" / "between <D1> and <D2>" — explicit range
  let m = text.match(
    /\b(?:from|between)\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}),?\s+(?:to|and)\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
  );
  if (m) {
    const a = parseDateToken(m[1]!);
    const b = parseDateToken(m[2]!);
    if (a && b) return { from: a.day, to: b.nextDay };
  }
  // 2) "as of / as at / by / before / until <D>" → inclusive through that day
  m = text.match(
    new RegExp(`\\b(?:as of|as at|by|before|until|up to)\\s+(${DATE_TOKEN.source})\\b`, "i"),
  );
  if (m) {
    const d = parseDateToken(m[1]!);
    if (d) return { to: d.nextDay };
  }
  // 3) "on <D>" → that exact day
  m = text.match(new RegExp(`\\bon\\s+(${DATE_TOKEN.source})\\b`, "i"));
  if (m) {
    const d = parseDateToken(m[1]!);
    if (d) return { from: d.day, to: d.nextDay };
  }
  // 4) "after / since <D>" → from that day onward
  m = text.match(new RegExp(`\\b(?:after|since)\\s+(${DATE_TOKEN.source})\\b`, "i"));
  if (m) {
    const d = parseDateToken(m[1]!);
    if (d) return { from: d.day };
  }
  return {};
}

export function parseAdvancedQuery(query: string): ParsedAdvancedQuery {
  const parsed = (sqp.parse(query, PARSER_OPTIONS) ?? {}) as Parsed;
  const semantic = Array.isArray(parsed.text)
    ? parsed.text.join(" ").trim()
    : (parsed.text ?? "").trim();
  const excludeTerms = asList(parsed.exclude?.text) ?? [];
  const range = parsed.time ? parseDateRange(parsed.time) : extractEventWindow(semantic);
  return {
    semantic,
    filters: {
      types: asList(parsed.type),
      nodeNames: parsed.node !== undefined ? [parsed.node] : undefined,
      stateKeys: asList(parsed.state),
      eventTimeFrom: range.from,
      eventTimeTo: range.to,
      excludeTerms: excludeTerms.map((term) => term.toLocaleLowerCase("en-US")),
    },
  };
}

/** Applies parsed filters to a ranked candidate list (keeps relative order). */
export function applyAdvancedFilters<
  T extends {
    memory: {
      memoryType?: string;
      stateKey?: string | null;
      eventTime?: string | null;
      statement: string;
    };
    node?: { canonicalName: string };
  },
>(results: readonly T[], filters: AdvancedQueryFilters): T[] {
  const typeSet = filters.types ? new Set(filters.types) : null;
  const nodeSet = filters.nodeNames
    ? filters.nodeNames.map((name) => name.toLocaleLowerCase("en-US"))
    : null;
  const stateSet = filters.stateKeys ? new Set(filters.stateKeys) : null;
  const fromMs = filters.eventTimeFrom ? Date.parse(filters.eventTimeFrom) : null;
  const toMs = filters.eventTimeTo ? Date.parse(filters.eventTimeTo) : null;
  const excluded = filters.excludeTerms;
  return results.filter((result) => {
    if (typeSet && !typeSet.has(result.memory.memoryType ?? "")) return false;
    if (
      nodeSet &&
      !nodeSet.some((name) =>
        (result.node?.canonicalName ?? "").toLocaleLowerCase("en-US").includes(name),
      )
    )
      return false;
    if (stateSet && !stateSet.has(result.memory.stateKey ?? "")) return false;
    if (fromMs !== null || toMs !== null) {
      const eventMs = result.memory.eventTime ? Date.parse(result.memory.eventTime) : null;
      if (eventMs === null || Number.isNaN(eventMs)) return false;
      if (fromMs !== null && eventMs < fromMs) return false;
      if (toMs !== null && eventMs > toMs) return false;
    }
    if (excluded.length > 0) {
      const text =
        `${result.memory.statement} ${result.node?.canonicalName ?? ""}`.toLocaleLowerCase("en-US");
      if (excluded.some((term) => text.includes(term))) return false;
    }
    return true;
  });
}
