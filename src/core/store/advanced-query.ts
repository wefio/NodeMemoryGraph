/**
 * Advanced search query syntax for nmg_search — powered by the mature
 * `search-query-parser` package (MIT, zero-dependency), which implements
 * search-engine style operators (keyword:value lists, "-" exclusions,
 * quoted phrases) with correct Unicode/Chinese token handling.
 *
 *   "迈阿密 酒店 type:preference,constraint -海景"    filters + exclude
 *   node:"Conversation a1b2c3" 潜水                     node-scoped clause
 *   time:2026-01-01..2026-06-30 航班                   event-time window
 *   "上周三 干了什么"                                   中文事件时间窗
 *
 * The parser strips structured operators out of the semantic text; the caller
 * runs the semantic remainder through normal retrieval and applies `filters`
 * as post-filters over the ranked candidates. Exclusions and phrases stay out
 * of the FTS expression (semantic + post-filter is precise enough at NMG's
 * evidence scale, and keeps the retrieval path free of FTS injection shapes).
 * Event-time windows become canonical UTC bounds here (see ../event-time.ts);
 * `eventTimeSource` tells an explicit operator apart from a phrase inferred out
 * of the query, because only the first is precise enough to empty a result set.
 */

import {
  eventTimeMillis,
  eventWindowEnd,
  eventWindowStart,
  extractChineseEventWindow,
} from "../event-time.ts";
import sqp from "search-query-parser";

export interface AdvancedQueryFilters {
  /** memory_type values, OR-ed (comma list). */
  types?: string[];
  /** memory_nodes.canonical_name values, OR-ed. */
  nodeNames?: string[];
  /** state_key values, OR-ed. */
  stateKeys?: string[];
  /** event_time range: canonical UTC bounds, both inclusive. */
  eventTimeFrom?: string;
  eventTimeTo?: string;
  /** Where the window came from: an explicit `time:` operator or the query text. */
  eventTimeSource?: "explicit" | "natural";
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

/** `time:a..b` (either side optional) → canonical inclusive bounds. A single
 *  value means "that day/month/year", so it becomes both bounds of the grain. */
function parseDateRange(value: string, now: Date): { from?: string; to?: string } {
  const parts = value.split("..");
  if (parts.length === 2) {
    const from = eventWindowStart(parts[0] || null, now);
    const to = eventWindowEnd(parts[1] || null, now);
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  const from = eventWindowStart(value, now);
  const to = eventWindowEnd(value, now);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

// ── Natural-language event-time extraction ────────────────────────────────
// Benchmarks ask temporal questions ("as of Mar 10, 2029", "on Sep 13, 2029",
// "from Feb 28, 2035 to Feb 28, 2036") and Chinese queries answer them
// casually ("上周三做了什么", "3月10号之前"). Parse the mention into an inclusive
// event-time window so retrieval filters by the question date instead of
// ranking future memories above the ones current at that time.

const DATE_TOKEN =
  /[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{1,2}-\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|[A-Za-z]{3,9}\.?\s+\d{4}/;

/**
 * Natural-language window for English prepositions and Chinese phrases alike.
 * Both sides become canonical UTC bounds (inclusive), so the same values can be
 * bound into candidate SQL and compared against stored `event_time` text.
 */
export function extractEventWindow(
  text: string,
  now: Date = new Date(),
): { from?: string; to?: string } {
  // 1) "from <D1> to <D2>" / "between <D1> and <D2>" — explicit range
  let m = text.match(
    new RegExp(
      `\\b(?:from|between)\\s+(${DATE_TOKEN.source}),?\\s+(?:to|and)\\s+(${DATE_TOKEN.source})\\b`,
      "i",
    ),
  );
  if (m) {
    const from = eventWindowStart(m[1]!, now);
    const to = eventWindowEnd(m[2]!, now);
    if (from || to) return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  // 2) "as of / as at / by / before / until <D>" → inclusive through that day
  m = text.match(
    new RegExp(`\\b(?:as of|as at|by|before|until|up to)\\s+(${DATE_TOKEN.source})\\b`, "i"),
  );
  if (m) {
    const to = eventWindowEnd(m[1]!, now);
    if (to) return { to };
  }
  // 3) "on <D>" → that exact day
  m = text.match(new RegExp(`\\bon\\s+(${DATE_TOKEN.source})\\b`, "i"));
  if (m) {
    const from = eventWindowStart(m[1]!, now);
    const to = eventWindowEnd(m[1]!, now);
    if (from) return { from, ...(to ? { to } : {}) };
  }
  // 4) "after / since <D>" → from that day onward
  m = text.match(new RegExp(`\\b(?:after|since)\\s+(${DATE_TOKEN.source})\\b`, "i"));
  if (m) {
    const from = eventWindowStart(m[1]!, now);
    if (from) return { from };
  }
  // 5) Chinese: 上周三 / 上个月 / 3月10号之前 / 从A到B
  return extractChineseEventWindow(text, now);
}

export function parseAdvancedQuery(query: string, now: Date = new Date()): ParsedAdvancedQuery {
  const parsed = (sqp.parse(query, PARSER_OPTIONS) ?? {}) as Parsed;
  const semantic = Array.isArray(parsed.text)
    ? parsed.text.join(" ").trim()
    : (parsed.text ?? "").trim();
  const excludeTerms = asList(parsed.exclude?.text) ?? [];
  const explicit = parsed.time !== undefined;
  const range = explicit ? parseDateRange(parsed.time!, now) : extractEventWindow(semantic, now);
  return {
    semantic,
    filters: {
      types: asList(parsed.type),
      nodeNames: parsed.node !== undefined ? [parsed.node] : undefined,
      stateKeys: asList(parsed.state),
      eventTimeFrom: range.from,
      eventTimeTo: range.to,
      ...(range.from || range.to
        ? { eventTimeSource: explicit ? ("explicit" as const) : ("natural" as const) }
        : {}),
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
      // Legacy rows may still hold a phrase or a narrow ISO shape; compare the
      // canonical instant so an actionable boundary cannot drop them silently.
      const eventMs = eventTimeMillis(result.memory.eventTime);
      if (eventMs === null) return false;
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
