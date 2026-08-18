/**
 * Dataset loaders for the formalized retrieval-quality benchmark.
 *
 * Each loader returns ingestion units (per-user conversations) and questions
 * with gold evidence texts, in the match direction that fits the gold
 * granularity (see score.ts). Gold normalization happens in score.ts; loaders
 * return raw text.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { MatchDirection } from "./score.ts";

export interface EvalMessage {
  role: string;
  content: string;
  chat_time?: string;
}

export interface EvalConversation {
  userId: string;
  conversationId: string;
  messages: EvalMessage[];
}

export interface EvalQuestion {
  id: string;
  userId: string;
  query: string;
  category: string;
  golds: string[];
}

export interface DatasetSpec {
  name: "locomo" | "longmemeval" | "beam";
  dataPath: string;
  sha256: string;
  direction: MatchDirection;
  conversations: EvalConversation[];
  questions: EvalQuestion[];
  /** Human-readable sample rule, recorded in the report manifest. */
  sampleNote: string;
}

export interface LoadOptions {
  /** undefined = pinned default sample, "full" = entire dataset. */
  full?: boolean;
  limit?: number;
}

const DATA_ROOT = ".benchmarks/official/OmniMemEval/data";

export const PINNED_DEFAULTS = {
  locomo: { limit: undefined as number | undefined, note: "all 10 users" },
  longmemeval: { limit: 100, note: "first 100 questions (use --full for all 500)" },
  beam: { limit: undefined as number | undefined, note: "all 20 conversations" },
} as const;

export function loadDataset(
  name: DatasetSpec["name"],
  options: LoadOptions = {},
  dataRoot: string = DATA_ROOT,
): DatasetSpec {
  switch (name) {
    case "locomo":
      return loadLocomo(resolve(dataRoot, "locomo/locomo10.json"), options);
    case "longmemeval":
      return loadLongMemEval(
        resolve(dataRoot, "longmemeval/longmemeval_s_cleaned.json"),
        options,
      );
    case "beam":
      return loadBeam(resolve(dataRoot, "beam/beam_100k.json"), options);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function take<T>(items: T[], limit: number | undefined): T[] {
  return limit === undefined ? items : items.slice(0, limit);
}

function effectiveLimit(
  name: keyof typeof PINNED_DEFAULTS,
  options: LoadOptions,
): { limit: number | undefined; note: string } {
  if (options.full) return { limit: undefined, note: "full dataset" };
  if (options.limit !== undefined)
    return { limit: options.limit, note: `first ${options.limit} (explicit --limit)` };
  return { limit: PINNED_DEFAULTS[name].limit, note: PINNED_DEFAULTS[name].note };
}

// ── LoCoMo ─────────────────────────────────────────────────────────────────

interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

interface LocomoSample {
  qa: Array<{ question: string; evidence: string[]; category: number }>;
  conversation: Record<string, unknown> & { speaker_a: string; speaker_b: string };
}

function loadLocomo(path: string, options: LoadOptions): DatasetSpec {
  const samples = JSON.parse(readFileSync(path, "utf8")) as LocomoSample[];
  const { limit, note } = effectiveLimit("locomo", options);
  const selected = take(samples, limit);
  const conversations: EvalConversation[] = [];
  const questions: EvalQuestion[] = [];

  selected.forEach((sample, sampleIndex) => {
    const userId = `locomo_exp_user_${sampleIndex}`;
    const evidenceText = new Map<string, string>();
    const sessionKeys = Object.keys(sample.conversation)
      .filter((key) => /^session_\d+$/u.test(key))
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    for (const sessionKey of sessionKeys) {
      const turns = sample.conversation[sessionKey] as LocomoTurn[];
      const dateTime = sample.conversation[`${sessionKey}_date_time`];
      conversations.push({
        userId,
        conversationId: sessionKey,
        messages: turns.map((turn) => ({
          // Upstream convention: speaker_a is the user, speaker_b the peer;
          // content carries the speaker prefix like OmniMemEval's ingestion.
          role: turn.speaker === sample.conversation.speaker_a ? "user" : "assistant",
          content: `${turn.speaker}: ${turn.text}`,
          ...(typeof dateTime === "string" ? { chat_time: dateTime } : {}),
        })),
      });
      for (const turn of turns) evidenceText.set(turn.dia_id, turn.text);
    }
    for (const [qaIndex, qa] of sample.qa.entries()) {
      // Adversarial no-evidence questions, excluded like the legacy audit.
      if (qa.category === 5) continue;
      const golds = qa.evidence
        .flatMap((value) => value.split(/[;,]\s*/u))
        .map((id) => evidenceText.get(id.trim()))
        .filter((text): text is string => typeof text === "string" && text.length > 0);
      questions.push({
        id: `locomo_${sampleIndex}_${qaIndex}`,
        userId,
        query: qa.question,
        category: String(qa.category),
        golds,
      });
    }
  });

  return {
    name: "locomo",
    dataPath: path,
    sha256: sha256(path),
    direction: "gold-in-candidate",
    conversations,
    questions,
    sampleNote: note,
  };
}

// ── LongMemEval-S ───────────────────────────────────────────────────────────

interface LmeItem {
  question_id: string;
  question_type: string;
  question: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

function loadLongMemEval(path: string, options: LoadOptions): DatasetSpec {
  const items = JSON.parse(readFileSync(path, "utf8")) as LmeItem[];
  const { limit, note } = effectiveLimit("longmemeval", options);
  const selected = take(items, limit);
  const conversations: EvalConversation[] = [];
  const questions: EvalQuestion[] = [];

  for (const item of selected) {
    const userId = `lme_${item.question_id}`;
    item.haystack_sessions.forEach((turns, sessionIndex) => {
      conversations.push({
        userId,
        conversationId: item.haystack_session_ids[sessionIndex] ?? `session_${sessionIndex}`,
        messages: turns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          ...(item.haystack_dates[sessionIndex]
            ? { chat_time: item.haystack_dates[sessionIndex] }
            : {}),
        })),
      });
    });
    const golds = item.answer_session_ids
      .map((id) => {
        const index = item.haystack_session_ids.indexOf(id);
        if (index < 0) return null;
        return item.haystack_sessions[index]!.map((turn) => turn.content).join("\n");
      })
      .filter((blob): blob is string => blob !== null);
    questions.push({
      id: item.question_id,
      userId,
      query: item.question,
      category: item.question_type,
      golds,
    });
  }

  return {
    name: "longmemeval",
    dataPath: path,
    sha256: sha256(path),
    direction: "candidate-in-gold",
    conversations,
    questions,
    sampleNote: note,
  };
}

// ── BEAM ────────────────────────────────────────────────────────────────────

interface BeamMessage {
  id: number;
  role: string;
  content: string;
  time_anchor?: string;
}

interface BeamConversation {
  conversation_id: string | number;
  chat: BeamMessage[][];
  /** Python-dict literal: capability -> question entries with source_chat_ids. */
  probing_questions: string;
}

function loadBeam(path: string, options: LoadOptions): DatasetSpec {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const { limit, note } = effectiveLimit("beam", options);
  const selected = take(lines, limit);
  const conversations: EvalConversation[] = [];
  const questions: EvalQuestion[] = [];

  for (const line of selected) {
    const conversation = JSON.parse(line) as BeamConversation;
    const conversationId = String(conversation.conversation_id);
    const userId = `beam_conv_${conversationId}`;
    const messagesById = new Map<number, BeamMessage>();
    conversation.chat.forEach((session, sessionIndex) => {
      conversations.push({
        userId,
        conversationId: `session_${sessionIndex}`,
        messages: session.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.time_anchor ? { chat_time: message.time_anchor } : {}),
        })),
      });
      for (const message of session) messagesById.set(message.id, message);
    });
    const probing = parsePythonLiteral(conversation.probing_questions) as Record<
      string,
      Array<{ question?: string; source_chat_ids?: unknown }>
    >;
    let questionIndex = 0;
    for (const [capability, entries] of Object.entries(probing)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const golds = uniqueInts(entry?.source_chat_ids)
          .map((id) => messagesById.get(id)?.content)
          .filter((content): content is string => typeof content === "string" && content.length > 0);
        questions.push({
          id: `beam_${conversationId}_${questionIndex}`,
          userId,
          query: String(entry?.question ?? ""),
          category: capability,
          golds,
        });
        questionIndex += 1;
      }
    }
  }

  return {
    name: "beam",
    dataPath: path,
    sha256: sha256(path),
    direction: "gold-in-candidate",
    conversations,
    questions,
    sampleNote: note,
  };
}

function uniqueInts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n)))];
}

// ── Python literal parsing (BEAM probing_questions) ─────────────────────────
// Minimal recursive-descent parser for the dict/list/str/num/bool/None
// literals Python's repr produces; mirrors audit-beam-retrieval.py's
// ast.literal_eval without a Python dependency.

export function parsePythonLiteral(source: string): unknown {
  let pos = 0;

  const skipWs = () => {
    while (pos < source.length && /\s/u.test(source[pos]!)) pos += 1;
  };

  const parseString = (): string => {
    const quote = source[pos]!;
    pos += 1;
    let out = "";
    while (pos < source.length) {
      const ch = source[pos]!;
      if (ch === "\\") {
        const next = source[pos + 1]!;
        const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r" };
        out += escapes[next] ?? next;
        pos += 2;
        continue;
      }
      if (ch === quote) {
        pos += 1;
        return out;
      }
      out += ch;
      pos += 1;
    }
    throw new Error("unterminated string in Python literal");
  };

  const parseValue = (): unknown => {
    skipWs();
    const ch = source[pos];
    if (ch === "{") {
      pos += 1;
      const dict: Record<string, unknown> = {};
      skipWs();
      while (source[pos] !== "}") {
        const key = parseValue();
        skipWs();
        if (source[pos] !== ":") throw new Error(`expected ':' at ${pos}`);
        pos += 1;
        dict[String(key)] = parseValue();
        skipWs();
        if (source[pos] === ",") {
          pos += 1;
          skipWs();
        }
      }
      pos += 1;
      return dict;
    }
    if (ch === "[" || ch === "(") {
      const close = ch === "[" ? "]" : ")";
      pos += 1;
      const list: unknown[] = [];
      skipWs();
      while (source[pos] !== close) {
        list.push(parseValue());
        skipWs();
        if (source[pos] === ",") {
          pos += 1;
          skipWs();
        }
      }
      pos += 1;
      return list;
    }
    if (ch === "'" || ch === '"') return parseString();
    const rest = source.slice(pos);
    const keyword = /^(True|False|None)\b/u.exec(rest);
    if (keyword) {
      pos += keyword[0].length;
      return keyword[0] === "True" ? true : keyword[0] === "False" ? false : null;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest);
    if (number) {
      pos += number[0].length;
      return Number(number[0]);
    }
    throw new Error(`unexpected token at ${pos}: ${rest.slice(0, 20)}`);
  };

  const value = parseValue();
  skipWs();
  if (pos < source.length) throw new Error(`trailing content at ${pos}`);
  return value;
}
