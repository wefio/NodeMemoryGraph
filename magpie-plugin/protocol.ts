export type GatewayProtocol = "chat" | "responses" | "anthropic" | "gemini";

const START = "<nmg-context>";
const END = "</nmg-context>";

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => String(part?.text ?? "")).join("\n");
}

function replaceContext(existing: string, context: string): string {
  const clean = existing.replace(/\n?<nmg-context>[\s\S]*?<\/nmg-context>\n?/g, "").trimEnd();
  return [clean, `${START}\n${context}\n${END}`].filter(Boolean).join("\n\n");
}

/** Only protocol-owned instruction fields change. Native tool declarations and input stay intact. */
export function injectContext(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
  context: string,
): Record<string, unknown> {
  const result = structuredClone(body);
  switch (protocol) {
    case "responses":
      if (body.instructions !== undefined && typeof body.instructions !== "string")
        throw new Error("Unsupported Responses instruction shape");
      result.instructions = replaceContext(String(body.instructions ?? ""), context);
      break;
    case "chat": {
      if (!Array.isArray(body.messages)) throw new Error("Chat messages must be an array");
      const messages = result.messages as Record<string, unknown>[];
      const prior = messages.find(
        (item) =>
          item.role === "system" &&
          typeof item.content === "string" &&
          item.content.includes(START),
      );
      if (prior) prior.content = replaceContext(String(prior.content), context);
      else messages.unshift({ role: "system", content: replaceContext("", context) });
      break;
    }
    case "anthropic":
      applyAnthropic(result, body, context);
      break;
    case "gemini":
      applyGemini(result, body, context);
      break;
    default:
      throw new Error("Unsupported gateway protocol");
  }
  return result;
}

function applyAnthropic(
  result: Record<string, unknown>,
  body: Record<string, unknown>,
  context: string,
): void {
  const prior = body.system;
  if (prior !== undefined && typeof prior !== "string" && !Array.isArray(prior))
    throw new Error("Unsupported Anthropic system shape");
  if (Array.isArray(prior)) {
    result.system = [
      ...prior.filter(
        (item) =>
          !(item?.type === "text" && typeof item.text === "string" && item.text.startsWith(START)),
      ),
      { type: "text", text: replaceContext("", context) },
    ];
  } else result.system = replaceContext(String(prior ?? ""), context);
}

function applyGemini(
  result: Record<string, unknown>,
  body: Record<string, unknown>,
  context: string,
): void {
  const key = Object.hasOwn(body, "system_instruction")
    ? "system_instruction"
    : "systemInstruction";
  const prior = body[key];
  if (
    prior !== undefined &&
    (!prior || typeof prior !== "object" || !Array.isArray((prior as { parts?: unknown }).parts))
  )
    throw new Error("Unsupported Gemini system instruction");
  const instruction = (prior ?? {}) as { parts?: Array<Record<string, unknown>> };
  result[key] = {
    ...instruction,
    parts: [
      ...(instruction.parts ?? []).filter(
        (part) => !(typeof part.text === "string" && part.text.startsWith(START)),
      ),
      { text: replaceContext("", context) },
    ],
  };
}

export function completedAnswer(reply: unknown, protocol: GatewayProtocol): string {
  if (!reply || typeof reply !== "object") return "";
  const value = reply as Record<string, unknown>;
  switch (protocol) {
    case "chat":
      return objects(value.choices)
        .map((choice) => text(object(choice.message).content))
        .join("\n");
    case "responses":
      return objects(value.output)
        .filter((item) => item.type === "message" && item.role === "assistant")
        .map((item) => text(item.content))
        .join("\n");
    case "anthropic":
      return text(value.content);
    case "gemini":
      return objects(value.candidates)
        .map((item) => text(object(item.content).parts))
        .join("\n");
    default:
      return "";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export function containsContext(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
  expected: string,
): boolean {
  switch (protocol) {
    case "responses":
      return text(body.instructions).includes(expected);
    case "anthropic":
      return text(body.system).includes(expected);
    case "gemini":
      return text(object(body.system_instruction ?? body.systemInstruction).parts).includes(
        expected,
      );
    case "chat":
      return objects(body.messages).some(
        (item) => item.role === "system" && text(item.content).includes(expected),
      );
    default:
      return false;
  }
}
