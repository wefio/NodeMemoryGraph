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

export function longMemEvalJudgePrompt(
  task: string,
  question: string,
  answer: string,
  response: string,
  abstention: boolean,
): string {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (task === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  const updateRule = task === "knowledge-update"
    ? " If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer."
    : " If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.";
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no.${updateRule}\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

function validateExample(value: unknown, index: number): LongMemExample {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`LongMemEval row ${index} must be an object`);
  }
  const row = value as Record<string, unknown>;
  for (const field of ["question_id", "question_type", "question"] as const) {
    if (typeof row[field] !== "string") {
      throw new Error(`LongMemEval row ${index} is missing ${field}`);
    }
  }
  if (!Array.isArray(row.haystack_sessions) || !Array.isArray(row.haystack_session_ids)) {
    throw new Error(`LongMemEval row ${index} is missing haystack sessions or IDs`);
  }
  if (typeof row.answer !== "string" && typeof row.answer !== "number") {
    throw new Error(`LongMemEval row ${index} is missing answer`);
  }
  return { ...row, answer: String(row.answer) } as unknown as LongMemExample;
}
