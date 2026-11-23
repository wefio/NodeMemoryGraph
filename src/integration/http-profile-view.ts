import type { MemoryMarker, MemoryRecord } from "../core/types.ts";

export interface ProfileHeadItem {
  readonly id: string;
  readonly kind: "forget_directive" | "preference";
  readonly text: string;
  readonly topic: string;
  readonly date: string | null;
  readonly orderKey: string;
  readonly freshness?: "new";
}

interface InternalProfileItem extends ProfileHeadItem {
  readonly tokens: Set<string>;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "from",
  "this",
  "have",
  "about",
  "into",
  "more",
  "than",
  "very",
  "just",
  "really",
  "usually",
  "always",
  "often",
  "enjoy",
  "like",
  "love",
  "prefer",
  "want",
  "please",
  "forget",
  "remember",
  "memory",
  "now",
  "instead",
  "rather",
  "switched",
  "changed",
  "moved",
  "used",
  "when",
  "where",
  "what",
  "which",
  "some",
  "could",
  "would",
]);

const MAX_PROFILE_LINE_CHARS = 180;

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLocaleLowerCase().matchAll(/\p{L}[\p{L}\p{N}_-]*/gu)) {
    const token = match[0];
    if (token.length >= 3 && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

export function topicOverlap(a: Set<string>, b: Set<string>): number {
  const minSize = Math.min(a.size, b.size);
  if (minSize === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  if (minSize === 1) return shared >= 1 ? 1 : 0;
  if (shared < 2) return 0;
  return shared / minSize;
}

function markerByKind(markers: readonly MemoryMarker[], kind: string): MemoryMarker | undefined {
  return markers.find((marker) => marker.kind === kind);
}

function memoryDate(memory: MemoryRecord): string | null {
  const raw = memory.eventTime ?? memory.createdAt;
  return raw ? raw.slice(0, 10) : null;
}

function suppressMatching(
  active: InternalProfileItem[],
  targetTokens: Set<string>,
  predicate: (item: InternalProfileItem) => boolean,
): InternalProfileItem[] {
  if (targetTokens.size === 0) return active;
  return active.filter(
    (item) => !(predicate(item) && topicOverlap(targetTokens, item.tokens) >= 0.6),
  );
}

function normalizeClip(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean.length <= MAX_PROFILE_LINE_CHARS
    ? clean
    : `${clean.slice(0, MAX_PROFILE_LINE_CHARS - 1).trim()}…`;
}

function recordOrderKey(memory: MemoryRecord): string {
  const timestamp = memory.eventTime ?? memory.createdAt ?? "";
  return `${timestamp}\0${memory.id}`;
}

function applyForgetToHead(
  active: InternalProfileItem[],
  memory: MemoryRecord,
  forget: MemoryMarker,
): InternalProfileItem[] {
  const topic = String(forget.attributes?.topic ?? memory.statement).trim();
  const tokens = contentTokens(topic);
  const next = suppressMatching(active, tokens, () => true);
  next.push({
    id: memory.id,
    kind: "forget_directive",
    text: normalizeClip(topic || memory.statement),
    topic,
    date: memoryDate(memory),
    orderKey: recordOrderKey(memory),
    tokens,
  });
  return next;
}

function applyPreferenceToHead(
  active: InternalProfileItem[],
  memory: MemoryRecord,
  update: MemoryMarker | undefined,
  pref: MemoryMarker | undefined,
): InternalProfileItem[] {
  let next = active;
  if (update) {
    next = suppressMatching(
      next,
      contentTokens(String(update.attributes?.replaced ?? "")),
      () => true,
    );
    next = suppressMatching(
      next,
      contentTokens(String(update.attributes?.current ?? memory.statement)),
      () => true,
    );
  } else {
    // Uncertain cross-session preferences keep all entries with dates;
    // only suppress matching earlier forget tombstones on the same topic.
    next = suppressMatching(
      next,
      contentTokens(memory.statement),
      (item) => item.kind === "forget_directive",
    );
  }
  const rawTopic = update?.attributes?.current ?? pref?.attributes?.summary ?? memory.statement;
  const topic = String(rawTopic).trim();
  const superseded = next.length < active.length;
  const out = next === active ? [...next] : next;
  out.push({
    id: memory.id,
    kind: "preference",
    text: normalizeClip(memory.statement),
    topic,
    date: memoryDate(memory),
    orderKey: recordOrderKey(memory),
    ...(superseded ? { freshness: "new" as const } : {}),
    tokens: contentTokens(topic || memory.statement),
  });
  return out;
}

function applyRecordToHead(
  active: InternalProfileItem[],
  memory: MemoryRecord,
): InternalProfileItem[] {
  const forget = markerByKind(memory.markers, "forget_directive");
  if (forget) return applyForgetToHead(active, memory, forget);
  const update = markerByKind(memory.markers, "preference_update");
  const pref = markerByKind(memory.markers, "persona_preference");
  if (!update && !pref) return active;
  return applyPreferenceToHead(active, memory, update, pref);
}

function hasSharedToken(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

function annotateCrossSessionFreshness(items: InternalProfileItem[]): InternalProfileItem[] {
  const marks: Array<"new" | undefined> = items.map((item) => item.freshness);
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.kind !== "preference") continue;
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[j]!.kind !== "preference") continue;
      if (!hasSharedToken(items[i]!.tokens, items[j]!.tokens)) continue;
      marks[i] = undefined;
      marks[j] = "new";
    }
  }
  return items.map((item, index) => {
    if (marks[index] === "new") return { ...item, freshness: "new" };
    if (!item.freshness) return item;
    const copy = { ...item };
    delete (copy as { freshness?: "new" }).freshness;
    return copy;
  });
}

function stripInternal(item: InternalProfileItem): ProfileHeadItem {
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    topic: item.topic,
    date: item.date,
    orderKey: item.orderKey,
    ...(item.freshness ? { freshness: item.freshness } : {}),
  };
}

function isProfileCandidate(memory: MemoryRecord): boolean {
  if (memory.sourceActor !== "user") return false;
  if (memory.memoryType !== "constraint" && memory.memoryType !== "preference") return false;
  return memory.markers.some(
    (m) =>
      m.kind === "forget_directive" ||
      m.kind === "preference_update" ||
      m.kind === "persona_preference",
  );
}

export function resolveHttpProfileHead(memories: readonly MemoryRecord[]): ProfileHeadItem[] {
  const candidates = memories.filter(isProfileCandidate).sort((a, b) => {
    const ka = `${a.eventTime ?? a.createdAt ?? ""}\0${a.id}`;
    const kb = `${b.eventTime ?? b.createdAt ?? ""}\0${b.id}`;
    return ka.localeCompare(kb);
  });
  let active: InternalProfileItem[] = [];
  for (const memory of candidates) {
    active = applyRecordToHead(active, memory);
  }
  return annotateCrossSessionFreshness(active).map(stripInternal);
}

function rankProfileItems(
  items: readonly ProfileHeadItem[],
  queryTokens: Set<string>,
  limit: number,
): ProfileHeadItem[] {
  const scored = items.map((item) => {
    const tokens = contentTokens(`${item.topic} ${item.text}`);
    let overlap = 0;
    for (const q of queryTokens) {
      if (tokens.has(q)) overlap += 1;
    }
    return { item, overlap };
  });
  const relevant = queryTokens.size > 0 ? scored.filter((entry) => entry.overlap > 0) : scored;
  return relevant
    .sort((a, b) => b.overlap - a.overlap || b.item.orderKey.localeCompare(a.item.orderKey))
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function renderHttpProfileSupplement(
  memories: readonly MemoryRecord[],
  query: string,
  options?: { maxPreferences?: number; maxTombstones?: number },
): string {
  const head = resolveHttpProfileHead(memories);
  if (head.length === 0) return "";
  const queryTokens = contentTokens(query);
  const tombstones = rankProfileItems(
    head.filter((item) => item.kind === "forget_directive"),
    queryTokens,
    options?.maxTombstones ?? 8,
  );
  const preferences = rankProfileItems(
    head.filter((item) => item.kind === "preference"),
    queryTokens,
    options?.maxPreferences ?? 12,
  );
  const combined = [...tombstones, ...preferences];
  if (combined.length === 0) return "";
  const lines = combined.map((item) => {
    const suffix = item.date ? ` (${item.date})` : "";
    const tag = item.freshness === "new" ? `[${item.kind}][new]` : `[${item.kind}]`;
    return `- ${tag} ${item.text}${suffix}`;
  });
  return `User Profile (current HEAD preferences & active forget directives):\n${lines.join("\n")}`;
}
