import type { DuplicateCandidate, DuplicateJudgement } from "./types.ts";

/**
 * External LLM judge consulted at write time on supersession candidates
 * (RememberResult.supersedeCandidates). NMG itself only detects shared-token
 * candidates (text-only); deciding whether the incoming statement is a newer
 * value for the same topic — and which candidate is the stale predecessor —
 * is delegated here. Same provider pattern as the embedding clients: NMG
 * ships no model, the caller configures an endpoint via NMG_JUDGE_*.
 */
export interface JudgeClient {
  readonly model: string;
  readonly baseUrl: string;
  judge(input: JudgeInput): Promise<DuplicateJudgement>;
}

export interface JudgeInput {
  statement: string;
  candidates: DuplicateCandidate[];
  supersedeCandidates?: DuplicateCandidate[];
}

export interface OpenAiCompatibleJudgeOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** DeepSeek-style reasoning: body gains thinking + reasoning_effort (no temperature). */
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

const JUDGE_SYSTEM_PROMPT = `You are a memory curation judge for a personal memory store.
A new statement is being written. Some existing same-scope memories are attached as candidates.
Decide the correct relation for the relevant candidate:

- "merge": the new statement is the same fact as a candidate (a duplicate, just reworded).
  Return memoryId = that candidate's id.
- "supersede": the new statement is a NEWER value for the same topic as a candidate —
  the candidate is the stale predecessor and should be marked superseded.
  Examples: "salary is 20k" later replaced by "salary is 30k";
  "currently Employed" later replaced by "self-employed"; "lives in Seattle"
  later replaced by "moved to Austin".
  Return supersededMemoryId = the stale candidate's id.
- "keep": the new statement is a distinct fact (no merge, no supersession).

A candidate is superseded only when it states an OUTDATED value for the same
single-valued attribute/state as the new statement. Multiple-valued facts
(friends, hobbies, plans, past events) are NOT superseded. If unsure, choose "keep".

Return ONLY JSON with no prose:
{"action": "merge"|"supersede"|"keep", "memoryId": "<candidate id>",
 "supersededMemoryId": "<candidate id>", "reason": "<short reason>"}`;

function buildUserMessage(input: JudgeInput): string {
  const lines = [
    `New statement:`,
    input.statement,
    ``,
    `Candidates:`,
  ];
  for (const c of input.supersedeCandidates ?? input.candidates) {
    lines.push(`- id=${c.memoryId} event_time=${c.eventTime ?? "unknown"} similarity=${c.similarity.toFixed(2)}`);
    lines.push(`  ${c.statement.slice(0, 400)}`);
  }
  return lines.join("\n");
}

/** Parse the model's JSON answer defensively; anything unexpected -> keep. */
function parseJudgement(raw: string): DuplicateJudgement {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as {
      action?: string;
      memoryId?: string;
      supersededMemoryId?: string;
      reason?: string;
    };
    const action = String(parsed.action ?? "").toLowerCase();
    const reason = parsed.reason ? String(parsed.reason).slice(0, 200) : undefined;
    if (action === "merge" && parsed.memoryId) {
      return { merge: true, reason };
    }
    if (action === "supersede" && parsed.supersededMemoryId) {
      return { merge: false, supersede: true, supersededMemoryId: String(parsed.supersededMemoryId), reason };
    }
    return { merge: false, reason };
  } catch {
    return { merge: false };
  }
}

export class OpenAiCompatibleJudgeClient implements JudgeClient {
  readonly model: string;
  readonly baseUrl: string;
  readonly #apiKey?: string;
  readonly #timeoutMs: number;
  readonly #thinking: boolean;
  readonly #reasoningEffort: "low" | "medium" | "high";
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleJudgeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#thinking = options.thinking ?? false;
    this.#reasoningEffort = options.reasoningEffort ?? "high";
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async judge(input: JudgeInput): Promise<DuplicateJudgement> {
    if ((input.supersedeCandidates?.length ?? 0) === 0) {
      return { merge: false };
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(input) },
      ],
      stream: false,
    };
    const deepSeekRequest = /deepseek/i.test(this.baseUrl) || /deepseek/i.test(this.model);
    if (this.#thinking) {
      // DeepSeek reasoning models (deepseek-v4-pro / deepseek-reasoner) take
      // thinking + reasoning_effort and reject temperature. Official example:
      //   curl https://api.deepseek.com/chat/completions -d '{"model":"deepseek-v4-pro",
      //   "thinking":{"type":"enabled"},"reasoning_effort":"high","stream":false,...}'
      body.thinking = { type: "enabled" };
      body.reasoning_effort = this.#reasoningEffort;
    } else if (deepSeekRequest) {
      body.temperature = 0;
      // DeepSeek V4 defaults to thinking mode server-side even when the
      // client sends no thinking field — that emits reasoning_content and can
      // leave content empty (slow + parse failures). Always send the explicit
      // disabled flag unless thinking was requested.
      body.thinking = { type: "disabled" };
    } else {
      body.temperature = 0;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) return { merge: false };
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null; reasoning_content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) return { merge: false };
      return parseJudgement(content);
    } catch {
      return { merge: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createJudgeClientFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): JudgeClient | undefined {
  const firstNonEmpty = (...values: Array<string | undefined>): string | undefined =>
    values.find((v) => v && v.trim().length > 0)?.trim();
  // Disable switch: NMG_JUDGE_DISABLED=1 (or "true").
  const disabledRaw = environment.NMG_JUDGE_DISABLED?.trim().toLowerCase();
  if (disabledRaw === "1" || disabledRaw === "true") return undefined;
  // Reuse whatever LLM the benchmark already configured. The eval bridge is a
  // Node child of nmg_client.py, which inherits the eval environment, so
  // EVAL_* (judge) and ANSWER_* (generation) are already present there.
  const baseUrl = firstNonEmpty(
    environment.NMG_JUDGE_BASE_URL,
    environment.EVAL_BASE_URL,
    environment.ANSWER_BASE_URL,
  );
  if (!baseUrl) return undefined;
  const apiKey = firstNonEmpty(
    environment.NMG_JUDGE_API_KEY,
    environment.EVAL_API_KEY,
    environment.ANSWER_API_KEY,
  );
  const model = firstNonEmpty(
    environment.NMG_JUDGE_MODEL,
    environment.EVAL_MODEL,
    environment.ANSWER_MODEL,
  );
  const timeoutRaw = environment.NMG_JUDGE_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 30_000;
  const thinkingRaw = environment.NMG_JUDGE_THINKING?.trim().toLowerCase();
  const thinking = thinkingRaw === "1" || thinkingRaw === "enabled" || thinkingRaw === "true";
  const effort = (environment.NMG_JUDGE_REASONING_EFFORT?.trim() || "high").toLowerCase();
  return new OpenAiCompatibleJudgeClient({
    baseUrl,
    apiKey,
    model: model || "deepseek-chat",
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30_000,
    thinking,
    reasoningEffort: effort === "low" || effort === "medium" ? effort : "high",
  });
}
