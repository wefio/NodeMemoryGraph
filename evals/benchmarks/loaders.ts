import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  BenchmarkCase,
  BenchmarkRole,
  BenchmarkSession,
  BenchmarkTurn,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

export function loadLocomo(path: string): BenchmarkCase[] {
  const rows = asArray(readJson(path));
  return rows.flatMap((row, conversationIndex) => {
    const item = asObject(row);
    const conversation = asObject(item.conversation);
    const sessionNames = Object.keys(conversation)
      .filter((key) => /^session_\d+$/u.test(key))
      .sort((left, right) => numericSuffix(left) - numericSuffix(right));
    const sessions = sessionNames.map((name): BenchmarkSession => ({
      id: name,
      date: stringValue(conversation[`${name}_date_time`]),
      turns: asArray(conversation[name]).map((turn, turnIndex) => {
        const value = asObject(turn);
        const speaker = stringValue(value.speaker);
        return {
          role: normalizeRole(speaker, conversation),
          ...(speaker ? { speaker } : {}),
          content: requiredString(value.text, `${name}[${turnIndex}].text`),
          sourceId: stringValue(value.dia_id) ?? `${name}:${turnIndex}`,
        };
      }),
    }));
    const sampleId = stringValue(item.sample_id) ?? String(conversationIndex);
    return asArray(item.qa).map((qa, questionIndex) => {
      const value = asObject(qa);
      return {
        id: stringValue(value.question_id) ?? `${sampleId}:${questionIndex}`,
        benchmark: "LoCoMo" as const,
        category: stringValue(value.category) ?? "unknown",
        question: requiredString(value.question, "qa.question"),
        reference: answerText(value.answer ?? value.adversarial_answer),
        evidenceIds: asArray(value.evidence).map(String),
        officialMetadata: {
          sampleId,
          category: value.category,
          evidence: value.evidence,
          adversarialAnswer: value.adversarial_answer,
        },
        sessions,
      };
    });
  });
}

export function loadPersonaMem(
  questionsPath: string,
  contextsPath: string,
): BenchmarkCase[] {
  const contexts = loadPersonaContexts(contextsPath);
  return parseCsv(readFileSync(resolve(questionsPath), "utf8")).map((row) => {
    const contextId = requiredString(row.shared_context_id, "shared_context_id");
    const messages = contexts.get(contextId);
    if (!messages) throw new Error(`PersonaMem context not found: ${contextId}`);
    const endIndex = Number.parseInt(row.end_index_in_shared_context ?? "", 10);
    const selected = Number.isFinite(endIndex) ? messages.slice(0, endIndex) : messages;
    const options = parseOptions(row.all_options ?? "");
    return {
      id: requiredString(row.question_id, "question_id"),
      benchmark: "PersonaMem" as const,
      category: row.question_type || "unknown",
      question: requiredString(row.user_question_or_message, "user_question_or_message"),
      reference: requiredString(row.correct_answer, "correct_answer"),
      options,
      officialMetadata: {
        personaId: row.persona_id,
        sharedContextId: contextId,
        endIndexInSharedContext: endIndex,
        topic: row.topic,
        correctAnswer: row.correct_answer,
      },
      sessions: [{
        id: contextId,
        turns: selected.map((message, index) => toTurn(message, `${contextId}:${index}`)),
      }],
    };
  });
}

export function loadBeam(chatsDirectory: string): BenchmarkCase[] {
  const roots = findFiles(resolve(chatsDirectory), "chat.json");
  return roots.flatMap((chatPath) => {
    const caseDirectory = resolve(chatPath, "..");
    const probingPath = join(caseDirectory, "probing_questions", "probing_questions.json");
    if (!existsFile(probingPath)) return [];
    const chatId = basename(caseDirectory);
    const sessions = asArray(readJson(chatPath)).map((batch, batchIndex) => {
      const value = asObject(batch);
      const batchNumber = stringValue(value.batch_number) ?? String(batchIndex + 1);
      return {
        id: `batch-${batchNumber}`,
        turns: asArray(value.turns).flatMap((group, groupIndex) =>
          asArray(group).map((message, messageIndex) =>
            toTurn(message, `${chatId}:${batchNumber}:${groupIndex}:${messageIndex}`),
          )),
      } satisfies BenchmarkSession;
    });
    const probing = asObject(readJson(probingPath));
    return Object.entries(probing).flatMap(([category, questions]) =>
      asArray(questions).map((question, questionIndex) => {
        const value = asObject(question);
        return {
          id: `${chatId}:${category}:${questionIndex}`,
          benchmark: "BEAM" as const,
          category,
          question: requiredString(value.question, `${category}.question`),
          reference: answerText(value.ideal_answer ?? value.ideal_response ?? value.rubric),
          evidenceIds: sourceChatIds(value.source_chat_ids),
          rubric: asArray(value.rubric).map(String),
          officialMetadata: { ...value },
          sessions,
        };
      }),
    );
  });
}

export function stratifiedSample(
  cases: BenchmarkCase[],
  perCategory: number,
): BenchmarkCase[] {
  const grouped = new Map<string, BenchmarkCase[]>();
  for (const item of cases) {
    const group = grouped.get(item.category) ?? [];
    group.push(item);
    grouped.set(item.category, group);
  }
  return [...grouped.keys()].sort().flatMap(
    (category) => grouped.get(category)!.slice(0, perCategory),
  );
}

function loadPersonaContexts(path: string): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>();
  for (const [lineIndex, line] of readFileSync(resolve(path), "utf8")
    .split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (Array.isArray(parsed)) {
      const first = parsed[0] && typeof parsed[0] === "object"
        ? asObject(parsed[0])
        : {};
      const id = stringValue(first.shared_context_id ?? first.context_id ?? first.id);
      if (!id) throw new Error(`PersonaMem context line ${lineIndex + 1} has no id`);
      result.set(id, parsed);
      continue;
    }
    const object = asObject(parsed);
    const id = stringValue(object.shared_context_id ?? object.context_id ?? object.id);
    const messages = object.context ?? object.messages ?? object.conversation;
    if (id && Array.isArray(messages)) {
      result.set(id, messages);
      continue;
    }
    for (const [key, value] of Object.entries(object)) {
      if (Array.isArray(value)) result.set(key, value);
    }
  }
  return result;
}

function toTurn(value: unknown, sourceId: string): BenchmarkTurn {
  const object = asObject(value);
  const content = object.content;
  return {
    role: normalizeRole(object.role ?? object.speaker),
    ...(stringValue(object.speaker) ? { speaker: stringValue(object.speaker)! } : {}),
    content: typeof content === "string"
      ? content
      : asArray(content).map((part) => {
        if (typeof part === "string") return part;
        const item = asObject(part);
        return stringValue(item.text) ?? "";
      }).join("\n"),
    sourceId: stringValue(object.id ?? object.index) ?? sourceId,
    officialMetadata: { ...object },
  };
}

function normalizeRole(value: unknown, conversation?: JsonObject): BenchmarkRole {
  const role = stringValue(value)?.toLocaleLowerCase();
  const speakerA = stringValue(conversation?.speaker_a)?.toLocaleLowerCase();
  if (role === "assistant" || role === "model") return "assistant";
  if (speakerA && role === speakerA) return "user";
  return role === "user" ? "user" : "assistant";
}

function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows.map((values) => Object.fromEntries(
    headers.map((header, index) => [header.replace(/^\uFEFF/u, ""), values[index] ?? ""]),
  ));
}

function parseOptions(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const normalized = trimmed.startsWith("[")
      ? trimmed.replaceAll("'", '"')
      : trimmed;
    const parsed: unknown = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return trimmed.match(/\([a-z]\)[\s\S]*?(?=\s*\([a-z]\)|$)/giu) ?? [trimmed];
  }
}

function sourceChatIds(value: unknown): string[] | undefined {
  const ids = new Set<string>();
  collectScalars(value, ids);
  return ids.size > 0 ? [...ids] : undefined;
}

function collectScalars(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScalars(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectScalars(item, output);
  } else if (value !== undefined && value !== null) output.add(String(value));
}

function findFiles(directory: string, name: string): string[] {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? findFiles(path, name)
      : entry === name ? [path] : [];
  });
}

function existsFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

function answerText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("; ");
  return requiredString(value, "reference answer");
}

function numericSuffix(value: string): number {
  return Number.parseInt(value.match(/\d+$/u)?.[0] ?? "0", 10);
}
