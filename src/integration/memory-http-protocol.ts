import { createHash, timingSafeEqual } from "node:crypto";
import {
  ContentValidationError,
  contentText,
  decodedImageBytes,
  describeContent,
  normalizeContent,
  type AmlContent,
} from "./multimodal-content.ts";

export type JsonObject = Record<string, unknown>;

export type HttpMemoryMessage = {
  role: "user" | "assistant";
  content: AmlContent;
  chat_time?: string;
  source_message_id: string;
  indexText?: string;
};

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function httpHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function memoryHttpOperation(
  method: string,
  path: string,
): "health" | "add" | "search" | undefined {
  if (path === "/health" && (method === "GET" || method === "HEAD")) return "health";
  if (method !== "POST") return;
  if (path === "/add") return "add";
  if (path === "/search") return "search";
}

export function readHttpTopK(input: JsonObject, fallback?: number): number {
  const value = input.top_k ?? input.topK ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100)
    throw new HttpError(400, "invalid_request", "top_k must be an integer between 1 and 100");
  return value;
}

export function readHttpQuery(query: unknown): Promise<string> {
  return describeContent(contentField(query, MAX_QUERY_CHARS));
}

export const MAX_QUERY_CHARS = 1_000_000;
export const MAX_MESSAGE_CHARS = 1_000_000;
export const MAX_COMBINED_MESSAGE_CHARS = 1_500_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ADD_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_ORDERED_CONTENT_BYTES = 48 * 1024 * 1024;

const HTTP_NOW_ISO =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Optional reference clock for Search (not part of AML; AML clients may omit it). */
export function readHttpNow(input: JsonObject): string | undefined {
  const value = input.now ?? input.current_time ?? input.timestamp;
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(new Date(value).getTime())
  )
    return new Date(value).toISOString();
  const match = typeof value === "string" ? HTTP_NOW_ISO.exec(value) : null;
  if (match && Number.isFinite(Date.parse(value as string))) {
    const [, year, month, day] = match;
    const check = new Date(Date.UTC(+year!, +month! - 1, +day!));
    if (
      check.getUTCFullYear() === +year! &&
      check.getUTCMonth() === +month! - 1 &&
      check.getUTCDate() === +day!
    )
      return value as string;
  }
  throw new HttpError(
    400,
    "invalid_request",
    "now must be Unix milliseconds or an ISO 8601 timestamp with Z or an offset",
  );
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function textField(value: unknown, label: string, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(
      400,
      "invalid_request",
      `${label} must be a nonempty string of at most ${max} characters`,
    );
  return value;
}
export function contentField(value: unknown, maxTextChars = MAX_MESSAGE_CHARS) {
  try {
    const content = normalizeContent(value, {
      maxTextChars,
      maxImageBytes: MAX_IMAGE_BYTES,
      maxImages: 32,
    });
    if (
      typeof content !== "string" &&
      new TextEncoder().encode(JSON.stringify(content)).length > MAX_ORDERED_CONTENT_BYTES
    ) {
      throw new HttpError(
        413,
        "content_too_large",
        `Ordered source content limit is ${MAX_ORDERED_CONTENT_BYTES} bytes`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof ContentValidationError)
      throw new HttpError(
        error.code === "content_too_large" ? 413 : 400,
        error.code,
        error.message,
      );
    throw error;
  }
}
function normalizeAddMessage(
  value: unknown,
): Omit<HttpMemoryMessage, "source_message_id" | "indexText"> {
  if (!isJsonObject(value)) throw new HttpError(400, "invalid_request", "Invalid message");
  const m = value;
  const content = contentField(m.content);
  const role = textField(m.role, "message.role", 64);
  if (role !== "user" && role !== "assistant")
    throw new HttpError(400, "invalid_request", "message.role must be user or assistant");
  let chat_time = m.chat_time;
  if (chat_time === undefined && m.timestamp !== undefined) {
    if (
      typeof m.timestamp !== "number" ||
      !Number.isFinite(m.timestamp) ||
      !Number.isFinite(new Date(m.timestamp).getTime())
    )
      throw new HttpError(400, "invalid_request", "timestamp must be Unix milliseconds");
    chat_time = new Date(m.timestamp).toISOString();
  }
  if (
    chat_time !== undefined &&
    (typeof chat_time !== "string" || !Number.isFinite(Date.parse(chat_time)))
  )
    throw new HttpError(400, "invalid_request", "chat_time must be a valid date string");
  return { role, content, ...(typeof chat_time === "string" ? { chat_time } : {}) };
}
export function readHttpAdd(input: JsonObject, maxMessages = 512) {
  const userId = textField(input.user_id ?? input.userId, "user_id");
  const requestId = textField(input.request_id, "request_id");
  const sessionId = textField(input.session_id ?? input.conversationId, "session_id");
  if (
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > maxMessages
  )
    throw new HttpError(
      400,
      "invalid_request",
      `messages must contain between 1 and ${maxMessages} messages`,
    );
  let chars = 0;
  let imageBytes = 0;
  const messages = input.messages.map((m) => {
    const message = normalizeAddMessage(m);
    chars += contentText(message.content).length;
    imageBytes += decodedImageBytes(message.content);
    return message;
  });
  if (chars > MAX_COMBINED_MESSAGE_CHARS)
    throw new HttpError(
      413,
      "request_too_large",
      `Combined message content limit is ${MAX_COMBINED_MESSAGE_CHARS} characters`,
    );
  if (imageBytes > MAX_ADD_IMAGE_BYTES)
    throw new HttpError(413, "request_too_large", "Combined image limit is 30 MiB per Add");
  return {
    userId,
    requestId,
    sessionId,
    messages,
    requestHash: httpHash(requestId),
    fingerprint: httpHash(JSON.stringify({ sessionId, messages })),
  };
}
export function requireHttpApiKey(request: Request, apiKey: string | undefined) {
  const authorization = request.headers.get("authorization") || "";
  const authorizationToken = authorization.match(/^(?:Bearer|Token)\s+(.+)$/i)?.[1] || "";
  const supplied = request.headers.get("x-api-key") || authorizationToken;
  if (!apiKey) throw new HttpError(503, "not_configured", "API authentication is not configured");
  if (!supplied || !timingSafeEqual(Buffer.from(httpHash(supplied)), Buffer.from(httpHash(apiKey))))
    throw new HttpError(
      401,
      "unauthorized",
      "A valid Token, Bearer, or X-API-Key credential is required",
    );
}
export async function readHttpJson(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<JsonObject> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new HttpError(
      413,
      "request_too_large",
      maxBytes === 6 * 1024 * 1024
        ? "Request limit is 6 MiB"
        : `Request limit is ${maxBytes} bytes`,
    );
  if (!request.body) throw new HttpError(400, "invalid_json", "JSON body required");
  // Nothing below this line has a deadline of its own, so this is the only place that can give a
  // stalled upload one instead of holding the invocation to the platform ceiling.
  const deadline = Date.now() + timeoutMs;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      if (Date.now() > deadline) {
        await reader.cancel().catch(() => {});
        throw new HttpError(408, "request_body_timeout", "Request body did not arrive in time");
      }
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(
          413,
          "request_too_large",
          maxBytes === 6 * 1024 * 1024
            ? "Request limit is 6 MiB"
            : `Request limit is ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!isJsonObject(v)) throw new Error("Expected object");
    return v;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}

const MAX_SEARCH_CLAUSES = 8;
/** One request may carry independent retrieval clauses: each is plain text plus
 * an optional label. The legacy `query`(+`options`) shape is one clause. */
type HttpSearchClause = { text: string; name: string | null; appendOnly?: boolean };

export async function readHttpClauses(input: JsonObject): Promise<HttpSearchClause[]> {
  const choices = input.options ?? [];
  if (!Array.isArray(choices) || choices.length > 16)
    throw new HttpError(400, "invalid_request", "options must be an array of at most 16 strings");
  const optionTexts = choices.map((choice) => textField(choice, "option", 4096));
  const nodes = input.queries;
  if (nodes === undefined) {
    // Preserve query text; use opaque image references or optional pixel descriptions.
    // Options never enter the vision request and are not used to infer an answer.
    const query = await readHttpQuery(input.query);
    return dedupeClauses([
      { text: query, name: null },
      ...optionTexts.map((choice) => ({ text: query + " " + choice, name: null })),
    ]);
  }
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > MAX_SEARCH_CLAUSES)
    throw new HttpError(
      400,
      "invalid_request",
      `queries must be an array of 1 to ${MAX_SEARCH_CLAUSES} clauses`,
    );
  if (optionTexts.length > 0)
    throw new HttpError(400, "invalid_request", "queries and options cannot be combined");
  if (input.query !== undefined)
    throw new HttpError(400, "invalid_request", "queries and query cannot be combined");
  const clauses = nodes.map((node) => {
    if (typeof node === "string")
      return { text: textField(node, "query", MAX_QUERY_CHARS), name: null, appendOnly: false };
    if (!isJsonObject(node))
      throw new HttpError(
        400,
        "invalid_request",
        "each query clause must be a string or an object with text",
      );
    const name = node.name === undefined ? null : textField(node.name, "name", 64);
    // appendOnly clause results never compete for the page; they are returned as
    // a supplement, so a broad dimension cannot crowd out ranked evidence.
    const appendOnly = node.appendOnly === true || node.mode === "append";
    return { text: textField(node.text ?? node.query, "query", MAX_QUERY_CHARS), name, appendOnly };
  });
  if (clauses[0].appendOnly)
    throw new HttpError(
      400,
      "invalid_request",
      "the first clause carries the presentation and cannot be appendOnly",
    );
  if (clauses.every((clause) => clause.appendOnly))
    throw new HttpError(400, "invalid_request", "at least one clause must be ranked");
  return dedupeClauses(clauses);
}
/** Identical clause text is collapsed before retrieval, keeping the first label,
 * so a fusion index always refers to one clause. */
function dedupeClauses(clauses: readonly HttpSearchClause[]) {
  const seen = new Set(),
    kept = [];
  for (const clause of clauses) {
    if (seen.has(clause.text)) continue;
    seen.add(clause.text);
    kept.push(clause);
  }
  return kept;
}

export function sourceHttpMessageId(requestHash: string, index: number): string {
  return `aml:${requestHash}:${index}`;
}

export function httpAddReceipt(
  { requestId, userId, sessionId }: { requestId: string; userId: string; sessionId: string },
  taskId: string,
  added: number,
) {
  return {
    success: true,
    request_id: requestId,
    user_id: userId,
    session_id: sessionId,
    task_id: taskId,
    status: "completed",
    added,
  };
}
