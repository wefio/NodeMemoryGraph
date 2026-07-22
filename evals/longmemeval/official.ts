import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LongMemTurn {
  role: "assistant" | "user";
  content: string;
  has_answer?: boolean;
}

export interface LongMemExample {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemTurn[][];
  answer_session_ids: string[];
}

export interface OfficialRetrievalMetrics {
  recallAny: number;
  recallAll: number;
  ndcg: number;
}

export function loadLongMemEval(path: string): LongMemExample[] {
  const value: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!Array.isArray(value)) throw new Error("LongMemEval data must be a JSON array");
  return value.map((row, index) => validateExample(row, index));
}

export function scoreLongMemRetrieval(
  rankedSessionIds: string[],
  answerSessionIds: string[],
): OfficialRetrievalMetrics | null {
  if (answerSessionIds.length === 0) return null;
  const relevant = new Set(answerSessionIds);
  const retrieved = rankedSessionIds.filter((id) => relevant.has(id));
  const recallAny = retrieved.length > 0 ? 1 : 0;
  const recallAll = new Set(retrieved).size === relevant.size ? 1 : 0;
  const dcg = rankedSessionIds.reduce(
    (sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const ideal = [...relevant].reduce(
    (sum, _id, index) => sum + 1 / Math.log2(index + 2),
    0,
  );
  return { recallAny, recallAll, ndcg: ideal === 0 ? 0 : dcg / ideal };
}

function validateExample(value: unknown, index: number): LongMemExample {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`LongMemEval row ${index} must be an object`);
  }
  const row = value as Record<string, unknown>;
  for (const field of ["question_id", "question_type", "question", "answer"] as const) {
    if (typeof row[field] !== "string") {
      throw new Error(`LongMemEval row ${index} is missing ${field}`);
    }
  }
  if (!Array.isArray(row.haystack_sessions) || !Array.isArray(row.haystack_session_ids)) {
    throw new Error(`LongMemEval row ${index} is missing haystack sessions or IDs`);
  }
  return row as unknown as LongMemExample;
}
