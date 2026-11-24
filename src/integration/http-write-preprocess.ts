import {
  ComputeRegistry,
  INPUT_NODE_ID,
  evaluateSyncComputeGraph,
  type ComputeGraphSpec,
} from "../core/compute-graph.ts";
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

interface WritePreprocessInput {
  readonly role: "user" | "assistant";
  readonly text: string;
}

interface ForgetStageState extends WritePreprocessInput {
  readonly active: boolean;
  readonly hasForget: boolean;
  readonly markers: MemoryMarker[];
  readonly triggers: string[];
  readonly seen: Set<string>;
}

interface PreferenceStageState extends ForgetStageState {
  readonly hasPref: boolean;
}

function buildWritePreprocessRegistry(): ComputeRegistry<unknown> {
  const registry = new ComputeRegistry<unknown>();
  const pureMeta = {
    version: "1.0.0",
    effect: "pure" as const,
    contract: "memory.write_preprocess",
    cacheable: true,
    parallelSafe: true,
    resources: { execution: "sync" as const, backend: "js" as const },
  };

  registry.register(
    "extract_forget_directive",
    (inputs): ForgetStageState => {
      const req = inputs.default as WritePreprocessInput;
      if (req.role !== "user" || !req.text.trim()) {
        return {
          ...req,
          active: false,
          hasForget: false,
          markers: [],
          triggers: [],
          seen: new Set(),
        };
      }
      const markers: MemoryMarker[] = [];
      const triggers: string[] = [];
      const seen = new Set<string>();
      const hasForget = applyForgetMatch(req.text, markers, triggers, seen);
      return { ...req, active: true, hasForget, markers, triggers, seen };
    },
    pureMeta,
  );

  registry.register(
    "extract_preference_signals",
    (inputs): PreferenceStageState => {
      const state = inputs.default as ForgetStageState;
      if (!state.active) return { ...state, hasPref: false };
      const markers = [...state.markers];
      const triggers = [...state.triggers];
      const seen = new Set(state.seen);
      const hasPref = applyPreferenceMatches(state.text, state.hasForget, markers, triggers, seen);
      return { ...state, markers, triggers, seen, hasPref };
    },
    pureMeta,
  );

  registry.register(
    "classify_turn_type",
    (inputs): PreprocessedHttpMessage => {
      const state = inputs.default as PreferenceStageState;
      if (!state.active) return { memoryType: "event", markers: [], recallTriggers: [] };
      const memoryType = state.hasForget ? "constraint" : state.hasPref ? "preference" : "event";
      return { memoryType, markers: state.markers, recallTriggers: state.triggers };
    },
    pureMeta,
  );

  return registry;
}

export const HTTP_WRITE_PREPROCESS_REGISTRY = buildWritePreprocessRegistry();

export const DEFAULT_HTTP_WRITE_PREPROCESS_GRAPH: ComputeGraphSpec = {
  id: "http-write-preprocess-v1",
  nodes: [
    { id: "forget", op: "extract_forget_directive", contract: "memory.write_preprocess" },
    { id: "prefs", op: "extract_preference_signals", contract: "memory.write_preprocess" },
    { id: "classify", op: "classify_turn_type", contract: "memory.write_preprocess" },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "forget" },
    { from: "forget", to: "prefs" },
    { from: "prefs", to: "classify" },
  ],
  output: "classify",
};

/**
 * Lightweight deterministic write preprocessor for HTTP conversation turns.
 * Extracts explicit forget directives, same-turn replacements, and first-person preferences.
 */
export function preprocessHttpMessage(
  role: "user" | "assistant",
  text: string,
  graph: ComputeGraphSpec = DEFAULT_HTTP_WRITE_PREPROCESS_GRAPH,
): PreprocessedHttpMessage {
  return evaluateSyncComputeGraph<WritePreprocessInput, PreprocessedHttpMessage, unknown>(
    graph,
    HTTP_WRITE_PREPROCESS_REGISTRY,
    { role, text },
    {},
  );
}
