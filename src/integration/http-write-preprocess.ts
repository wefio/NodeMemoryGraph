import { MAX_RECALL_TRIGGER_CHARACTERS } from "../core/recall-triggers.ts";
import type { MemoryMarker } from "../core/types.ts";

export interface PreprocessedHttpMessage {
  readonly memoryType: "event" | "constraint" | "preference";
  readonly markers: readonly MemoryMarker[];
  readonly recallTriggers: readonly string[];
}

const FORGET_EN_RE =
  /\b(?:(?:please\s+)?(?:forget|erase|delete|remove|disregard)|(?:don't|do not|stop)\s+(?:remember|keep|mention|use))\b\s*(?:all\s+(?:my\s+)?)?(?:about\s+|regarding\s+|that\s+)?([^.!?\n;]{3,100})/iu;
const FORGET_ZH_RE = /(?:请忘记|忘掉|不要记住|删除关于)\s*([^。！？\n]{2,80})/u;
const FORGET_LEAD_RE = /^(?:that\s+i\s+|i\s+|my\s+|about\s+|regarding\s+)/iu;
const FORGET_VERB_RE =
  /^(?:frequently|occasionally|often|regularly|usually|sometimes|daily)?\s*(?:enjoy|like|love|prefer|appreciate|play|visit|follow|cook|attend|favor|favour|collect|practice|avoid|have|am|was|used to)\s+/iu;
const REPLACE_EN_RE =
  /\b(?:instead of|rather than|switched from|changed from|moved from|used to (?:like|love|prefer|enjoy|live in|work as))\s+([^,.;!?\n]{3,60}?)(?:,\s*|\s+(?:to|but now|now|i now|i prefer|i like|i love|i enjoy)\s+)([^.!?\n;]{3,80})/iu;
const PREF_EN_RE =
  /\b(?:i(?:'ve been|\s+have been|\s+(?:really|strongly|usually|always|often|occasionally|regularly|daily|secretly|actively))?\s+(?:prefer|love|like|enjoy|hate|dislike|avoid|can't stand|am allergic to|am passionate about|am interested in|work as|live in|practice|collect|play|cook|bake|keep|tend to|favor|favour|browse|listen to|dealing with|coping with)|my\s+(?:favorite|favourite|preference|goal|hobby|allergy|passion|routine|style))\s+([^.!?\n;,]{3,60}?)(?=\s*(?:[,.!?\n;]|\b(?:and|but|because|so)\s+i\b|$))/giu;

const MAX_EXTRACTED_TRIGGERS = 6;
const MAX_PREF_MARKERS = 3;

function clipTrigger(raw: string): string {
  const clean = raw
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[,:;-]+$/u, "")
    .trim();
  return clean.length <= MAX_RECALL_TRIGGER_CHARACTERS
    ? clean
    : clean.slice(0, MAX_RECALL_TRIGGER_CHARACTERS).trim();
}

function addTrigger(out: string[], seen: Set<string>, raw: string): void {
  const trigger = clipTrigger(raw);
  if (trigger.length < 3) return;
  const key = trigger.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(trigger);
}

function normalizeForgetTopic(raw: string): string {
  let stripped = raw.replace(/\s+/gu, " ").trim();
  for (let i = 0; i < 3; i += 1) {
    const next = stripped.replace(FORGET_LEAD_RE, "").replace(FORGET_VERB_RE, "").trim();
    if (next === stripped) break;
    stripped = next;
  }
  return clipTrigger(stripped || raw);
}

function applyForgetMatch(
  text: string,
  markers: MemoryMarker[],
  triggers: string[],
  seen: Set<string>,
): boolean {
  const forgetMatch = FORGET_EN_RE.exec(text) ?? FORGET_ZH_RE.exec(text);
  if (!forgetMatch) return false;
  const rawTopic = clipTrigger(forgetMatch[1]!);
  const topic = normalizeForgetTopic(rawTopic);
  markers.push({
    kind: "forget_directive",
    attributes: topic
      ? { topic, ...(rawTopic && rawTopic !== topic ? { raw_topic: rawTopic } : {}) }
      : undefined,
  });
  if (topic) addTrigger(triggers, seen, topic);
  if (rawTopic) addTrigger(triggers, seen, rawTopic);
  return true;
}

function applyPreferenceMatches(
  text: string,
  hasForget: boolean,
  markers: MemoryMarker[],
  triggers: string[],
  seen: Set<string>,
): boolean {
  let found = false;
  const replaceMatch = REPLACE_EN_RE.exec(text);
  if (replaceMatch && !hasForget) {
    found = true;
    const replaced = clipTrigger(replaceMatch[1]!);
    const current = clipTrigger(replaceMatch[2]!);
    markers.push({ kind: "preference_update", attributes: { replaced, current } });
    addTrigger(triggers, seen, current);
    addTrigger(triggers, seen, replaced);
  }
  let prefMarkers = 0;
  for (const match of text.matchAll(PREF_EN_RE)) {
    found = true;
    if (!hasForget && prefMarkers < MAX_PREF_MARKERS) {
      markers.push({ kind: "persona_preference", attributes: { summary: clipTrigger(match[0]) } });
      prefMarkers += 1;
    }
    if (triggers.length >= MAX_EXTRACTED_TRIGGERS) continue;
    addTrigger(triggers, seen, match[0]);
    if (match[1] && triggers.length < MAX_EXTRACTED_TRIGGERS) addTrigger(triggers, seen, match[1]);
  }
  return found;
}

/**
 * Lightweight deterministic write preprocessor for HTTP conversation turns.
 * Extracts explicit forget directives, same-turn replacements, and first-person preferences.
 */
export function preprocessHttpMessage(
  role: "user" | "assistant",
  text: string,
): PreprocessedHttpMessage {
  if (role !== "user" || !text.trim()) {
    return { memoryType: "event", markers: [], recallTriggers: [] };
  }
  const triggers: string[] = [];
  const seen = new Set<string>();
  const markers: MemoryMarker[] = [];

  const hasForget = applyForgetMatch(text, markers, triggers, seen);
  const hasPref = applyPreferenceMatches(text, hasForget, markers, triggers, seen);
  const memoryType = hasForget ? "constraint" : hasPref ? "preference" : "event";

  return { memoryType, markers, recallTriggers: triggers };
}
